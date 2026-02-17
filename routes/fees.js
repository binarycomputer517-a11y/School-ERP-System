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
const uuid = require('uuid');
const uuidv4 = uuid.v4;
const PDFDocument = require('pdfkit'); 
const axios = require('axios');
const { transporter } = require('../services/emailService');

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
    EXPENSES: 'expenses',
    EMAIL_LOGS: 'email_logs',
    
    SETTINGS: 'erp_settings' 
};

const FEE_ROLES = ['Admin', 'Staff', 'Super Admin', 'Finance'];

// --- Helper Functions ---
const generateInvoiceNumber = () => {
    return `INV-${moment().format('YYYYMMDD')}-${uuidv4().split('-')[0].toUpperCase().substring(0, 6)}`;
};

// =========================================================
// SECTION 2: CORE TRANSACTIONS (INVOICING, COLLECTION, REFUND)
// =========================================================

/**
 * 2.1 BULK COURSE INVOICE GENERATION (Branch-Aware & Secure)
 * @route   POST /api/finance/generate-structure-invoice
 * @desc    Generates invoices for all active students in the Admin's branch
 * @access  Private (Admin, Super Admin)
 */
router.post('/generate-structure-invoice', authenticateToken, authorize(['admin', 'super admin']), async (req, res) => {
    const adminId = req.user.id;
    const adminBranchId = req.user.branch_id; // Securely identify Admin's branch scope
    const issueDate = moment().format('YYYY-MM-DD'); 
    const dueDate = moment().add(30, 'days').format('YYYY-MM-DD'); 

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        // 1. Fetch Students linked with Fee Structure, restricted to Admin's branch
        let studentQuery = `
            SELECT 
                s.student_id, s.branch_id,
                u.username, 
                fs.id AS fee_structure_id,
                fs.structure_name,
                COALESCE(fs.admission_fee, 0) AS admission,
                COALESCE(fs.registration_fee, 0) AS registration,
                COALESCE(fs.exam_fee, 0) AS exam,
                COALESCE(fs.course_duration_months, 12) AS duration, 
                COALESCE(fs.transport_fee, 0) AS transport_struct_monthly,
                COALESCE(fs.hostel_fee, 0) AS hostel_struct_monthly
            FROM ${DB.STUDENTS} s
            JOIN ${DB.USERS} u ON s.user_id = u.id
            JOIN ${DB.FEE_STRUCT} fs ON s.course_id = fs.course_id AND s.batch_id = fs.batch_id
            WHERE u.is_active = TRUE
        `;

        const params = [];
        // 🛡️ BRANCH ISOLATION: Ensure data privacy between branches
        if (req.user.role !== 'super admin' && adminBranchId) {
            studentQuery += ` AND s.branch_id = $1::uuid`;
            params.push(adminBranchId);
        }

        const studentsRes = await client.query(studentQuery, params);

        let generatedCount = 0;
        let skippedCount = 0;

        for (const student of studentsRes.rows) {
            
            // 2. DUPLICATE CHECK: Avoid double-billing the same student for the same structure
            const checkDuplicate = await client.query(`
                SELECT id FROM ${DB.INVOICES} 
                WHERE student_id = $1::uuid AND fee_structure_id = $2::uuid
            `, [student.student_id, student.fee_structure_id]);

            if (checkDuplicate.rowCount > 0) { 
                skippedCount++; 
                continue; 
            }

            // 3. Calculate Totals (Excluding Tuition per your requirements)
            let totalAmount = 0;
            const items = [];
            const duration = student.duration;

            const addItem = (desc, amount) => {
                const amt = parseFloat(amount);
                if (amt > 0) {
                    items.push({ description: desc, amount: amt });
                    totalAmount += amt;
                }
            };
            
            addItem('Admission Fee', student.admission);
            addItem('Registration Fee', student.registration);
            addItem('exam_fee', student.exam);
            
            if (student.transport_struct_monthly > 0) {
                addItem(`Transport Fee (${duration} Months)`, student.transport_struct_monthly * duration);
            }
            
            if (student.hostel_struct_monthly > 0) {
                addItem(`Hostel Fee (${duration} Months)`, student.hostel_struct_monthly * duration);
            }

            if (totalAmount === 0) continue; 

            // 4. INSERT INVOICE HEADER (Explicitly saving branch_id)
            const invRes = await client.query(`
                INSERT INTO ${DB.INVOICES} 
                (student_id, branch_id, invoice_number, issue_date, due_date, total_amount, status, created_by, fee_structure_id)
                VALUES ($1::uuid, $2::uuid, $3, $4::date, $5::date, $6, 'Pending', $7::uuid, $8::uuid) 
                RETURNING id;
            `, [
                student.student_id, 
                student.branch_id, // Stamping the invoice with the student's branch
                generateInvoiceNumber(), 
                issueDate, 
                dueDate, 
                totalAmount, 
                adminId,
                student.fee_structure_id 
            ]);
            
            const invoiceId = invRes.rows[0].id;
            
            // 5. INSERT LINE ITEMS
            if (items.length > 0) {
                const itemsValues = items.map(item => `('${invoiceId}', '${item.description.replace(/'/g, "''")}', ${item.amount})`).join(',');
                await client.query(`INSERT INTO ${DB.ITEMS} (invoice_id, description, amount) VALUES ${itemsValues};`);
            }
            
            generatedCount++;
        }

        await client.query('COMMIT');
        res.status(201).json({ 
            message: `Bulk Generation Complete.`, 
            generated: generatedCount, 
            skipped: skippedCount 
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error("Bulk Generation Error:", error);
        res.status(500).json({ message: 'Failed to generate bulk invoices.' });
    } finally { client.release(); }
});
/**
 * 2.2 FEE COLLECTION (With Multi-Branch Security & Auto-Activation)
 * @desc   বিকাশ বা ক্যাশ কালেকশন করার সময় ব্রাঞ্চ ভ্যালিডেশন চেক করে
 */
router.post('/collect', authenticateToken, authorize(['admin', 'teacher', 'staff', 'super admin']), async (req, res) => {
    const { student_id, amount_paid, payment_mode, notes } = req.body;
    const collectedBy = req.user.id;
    const userBranchId = req.user.branch_id; // লগইন করা ইউজারের ব্রাঞ্চ আইডি
    const userRole = req.user.role; // ইউজারের রোল
    const payAmount = parseFloat(amount_paid);

    if (!student_id || !payAmount || payAmount <= 0) {
        return res.status(400).json({ message: 'Invalid payment details.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 🛡️ SECURITY STEP: স্টুডেন্টের ব্রাঞ্চ ভ্যালিডেশন
        const studentInfo = await client.query(`
            SELECT branch_id FROM ${DB.STUDENTS} WHERE student_id = $1::uuid
        `, [student_id]);

        if (studentInfo.rowCount === 0) {
            throw new Error("Student not found.");
        }

        const studentBranchId = studentInfo.rows[0].branch_id;

        // যদি ইউজার 'super admin' না হয় এবং ব্রাঞ্চ আইডি না মিলে, তবে অ্যাক্সেস ডিনাইড
        if (userRole !== 'super admin' && studentBranchId !== userBranchId) {
            return res.status(403).json({ 
                message: 'Access Denied: You cannot collect fees for a student from another branch.' 
            });
        }

        // 1. Fetch pending invoices
        const openInvoices = await client.query(`
            SELECT id, total_amount, paid_amount, (total_amount - parseFloat(paid_amount)) AS balance_due
            FROM ${DB.INVOICES} 
            WHERE student_id = $1::uuid AND status != 'Paid' AND status != 'Waived'
            ORDER BY due_date ASC;
        `, [student_id]);

        let totalDue = openInvoices.rows.reduce((acc, i) => acc + parseFloat(i.balance_due), 0);
        
        if (totalDue <= 0) throw new Error("No pending dues found for this student.");
        
        // ওভারপেমেন্ট চেক (Safety Margin: 0.01)
        if (payAmount > (totalDue + 0.01)) {
            throw new Error(`Overpayment detected. Total Due: ₹${totalDue.toFixed(2)}`);
        }

        let remaining = payAmount;
        let firstPaymentId = null;
        const batchRef = 'PAY-' + uuidv4().substring(0,8).toUpperCase();

        // 2. Distribute payment across invoices (FIFO Method)
        for (const inv of openInvoices.rows) {
            if (remaining <= 0) break;
            const due = parseFloat(inv.balance_due);
            const paying = Math.min(remaining, due);

            if (paying > 0) {
                const pRes = await client.query(`
                    INSERT INTO ${DB.PAYMENTS} (invoice_id, amount, payment_mode, transaction_id, collected_by, remarks) 
                    VALUES ($1::uuid, $2, $3, $4, $5::uuid, $6) RETURNING id;
                `, [inv.id, paying, payment_mode, batchRef, collectedBy, notes]);
                
                if (!firstPaymentId) firstPaymentId = pRes.rows[0].id; 

                const newPaid = parseFloat(inv.paid_amount) + paying;
                const newStatus = (newPaid >= (parseFloat(inv.total_amount) - 0.01)) ? 'Paid' : 'Partial';
                
                await client.query(`
                    UPDATE ${DB.INVOICES} 
                    SET paid_amount = paid_amount + $1, status = $2 
                    WHERE id = $3::uuid
                `, [paying, newStatus, inv.id]);

                remaining -= paying;
            }
        }

        // --- 🛑 3. AUTO-ACTIVATION CHECK ---
        const totalPaidRes = await client.query(`
            SELECT COALESCE(SUM(amount), 0) as total_collected 
            FROM ${DB.PAYMENTS} p
            JOIN ${DB.INVOICES} i ON p.invoice_id = i.id
            WHERE i.student_id = $1::uuid
        `, [student_id]);

        const totalCollected = parseFloat(totalPaidRes.rows[0].total_collected);

        // টাকা ১০০০ বা তার বেশি হলে অ্যাকাউন্ট অটোমেটিক অ্যাক্টিভ হবে
        if (totalCollected >= 1000) {
            await client.query(`
                UPDATE ${DB.USERS} 
                SET status = 'active', is_paid = true 
                WHERE id = (SELECT user_id FROM ${DB.STUDENTS} WHERE student_id = $1::uuid)
            `, [student_id]);
        }

        await client.query('COMMIT');
        res.status(201).json({ 
            success: true,
            message: `Payment successfully recorded: ₹${payAmount}`, 
            receipt_number: batchRef, // Batch reference can be used as Receipt No
            activation: totalCollected >= 1000 ? 'Student Account Activated' : 'Pending Activation'
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error("Collection Error:", error.message);
        res.status(400).json({ message: error.message || 'Payment processing failed.' });
    } finally {
        client.release();
    }
});
 //* 2.3 REFUND MANAGEMENT
 //*//
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

/**
 * 2.4 LIST STUDENTS ELIGIBLE FOR REFUND (Enterprise Final - Super Admin Bypass)
 * @route   GET /api/finance/list-for-refund
 * @desc    Fetch students with payment history for potential refund processing.
 * @access  Private (Admin, Finance, and Super Admin)
 */
router.get('/list-for-refund', authenticateToken, authorize(['admin', 'finance', 'super admin']), async (req, res) => {
    try {
        // Optimized query to handle null identification fields (Fixes the N/A issue)
        const query = `
            SELECT DISTINCT 
                s.student_id, 
                u.username AS student_name, 
                COALESCE(s.enrollment_no, s.roll_number, s.admission_id, 'PENDING') AS roll_number,
                c.course_name
            FROM ${DB.PAYMENTS} p
            JOIN ${DB.STUDENTS} s ON p.student_id = s.student_id
            JOIN ${DB.USERS} u ON s.user_id = u.id
            LEFT JOIN ${DB.COURSES} c ON s.course_id = c.id 
            ORDER BY u.username ASC
        `;
        
        const result = await pool.query(query);
        res.status(200).json(result.rows);

    } catch (error) {
        console.error("Institutional Refund Registry Sync Failure:", error.message);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to synchronize student refund telemetry: ' + error.message 
        });
    }
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

/**
 * 3.2 SMART STUDENT DASHBOARD (Auto-Generate & Summary)
 * ✅ FIX: Calculations now correctly include Tuition Fee * Duration
 * ✅ FIX: Added course_name and batch_name to final response
 */
router.get('/student/:studentId', authenticateToken, authorize(FEE_ROLES), async (req, res) => {
    const client = await pool.connect();
    try {
        const { studentId } = req.params;
        const adminId = req.user.id; 
        const userBranchId = req.user.branch_id; 

        const issueDate = moment().format('YYYY-MM-DD');
        const dueDate = moment().add(30, 'days').format('YYYY-MM-DD');

        await client.query('BEGIN');

        // 1. Fetch Student Details and Linked Fee Structure
        const sRes = await client.query(`
            SELECT 
                s.student_id, u.username, s.roll_number, s.branch_id,
                c.course_name, b.batch_name,
                fs.id AS fee_structure_id, fs.structure_name,
                COALESCE(fs.course_duration_months, 1) AS duration,
                COALESCE(fs.admission_fee, 0) AS admission,
                COALESCE(fs.registration_fee, 0) AS registration,
                COALESCE(fs.exam_fee, 0) AS exam,
                COALESCE(fs.tuition_fee, 0) AS monthly_tuition,
                COALESCE(fs.transport_fee, 0) AS transport_monthly, 
                COALESCE(fs.hostel_fee, 0) AS hostel_monthly,     
                ta.is_active AS transport_active,
                hr.room_fee AS hostel_room_rate
            FROM ${DB.STUDENTS} s 
            JOIN ${DB.USERS} u ON s.user_id = u.id 
            LEFT JOIN ${DB.COURSES} c ON s.course_id = c.id 
            LEFT JOIN ${DB.BATCHES} b ON s.batch_id = b.id
            LEFT JOIN ${DB.FEE_STRUCT} fs ON s.course_id = fs.course_id AND s.batch_id = fs.batch_id
            LEFT JOIN student_transport_assignments ta ON s.student_id = ta.student_id AND ta.is_active = TRUE
            LEFT JOIN student_hostel_assignments ha ON s.student_id = ha.student_id
            LEFT JOIN ${DB.HOSTEL} hr ON ha.hostel_rate_id = hr.id
            WHERE s.student_id = $1::uuid
        `, [studentId]);

        if (!sRes.rows[0]) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Student record not found' });
        }
        
        const student = sRes.rows[0];

        // 2. AUTO-GENERATE INVOICE LOGIC (If no invoice exists for this structure)
        if (student.fee_structure_id) {
            const invCheck = await client.query(`
                SELECT id FROM ${DB.INVOICES} 
                WHERE student_id = $1::uuid AND fee_structure_id = $2::uuid
            `, [student.student_id, student.fee_structure_id]);

            if (invCheck.rowCount === 0) {
                const duration = parseInt(student.duration);
                
                // Calculate Totals
                const totalTuition = parseFloat(student.monthly_tuition) * duration;
                const totalTransport = (student.transport_active) ? (parseFloat(student.transport_monthly) * duration) : 0;
                const hostelMonthly = student.hostel_room_rate || student.hostel_monthly;
                const totalHostel = parseFloat(hostelMonthly || 0) * duration;

                const totalAmount = totalTuition + totalTransport + totalHostel +
                    parseFloat(student.admission) + parseFloat(student.registration) + parseFloat(student.exam);

                if (totalAmount > 0) {
                    const invRes = await client.query(`
                        INSERT INTO ${DB.INVOICES} 
                        (student_id, branch_id, invoice_number, issue_date, due_date, total_amount, status, created_by, fee_structure_id)
                        VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, 'Pending', $7::uuid, $8::uuid) 
                        RETURNING id;
                    `, [student.student_id, student.branch_id || userBranchId, generateInvoiceNumber(), issueDate, dueDate, totalAmount, adminId, student.fee_structure_id]);
                    
                    const newInvId = invRes.rows[0].id;
                    const items = [
                        { d: 'Admission Fee', a: student.admission },
                        { d: 'Registration Fee', a: student.registration },
                        { d: 'Exam Fee', a: student.exam },
                        { d: `Tuition Fee (${duration} Months)`, a: totalTuition }
                    ];
                    if (totalTransport > 0) items.push({ d: `Transport Fee (${duration} Months)`, a: totalTransport });
                    if (totalHostel > 0) items.push({ d: `Hostel Fee (${duration} Months)`, a: totalHostel });

                    const finalItems = items.filter(i => parseFloat(i.a) > 0);
                    if (finalItems.length > 0) {
                        const itemsValues = finalItems.map(i => `('${newInvId}', '${i.d.replace(/'/g, "''")}', ${i.a})`).join(',');
                        await client.query(`INSERT INTO ${DB.ITEMS} (invoice_id, description, amount) VALUES ${itemsValues};`);
                    }
                }
            }
        }

        await client.query('COMMIT');

        // 3. FETCH AGGREGATED TOTALS & PAYMENT HISTORY
        const invoiceStats = await pool.query(`
            SELECT 
                COALESCE(SUM(total_amount), 0) AS total_invoiced, 
                COALESCE(SUM(paid_amount), 0) AS total_paid
            FROM ${DB.INVOICES} 
            WHERE student_id = $1::uuid AND status != 'Waived'
        `, [studentId]);

        const history = await pool.query(`
            SELECT p.transaction_id AS receipt_number, p.amount AS amount_paid, p.payment_mode, p.payment_date 
            FROM ${DB.PAYMENTS} p 
            JOIN ${DB.INVOICES} i ON p.invoice_id = i.id 
            WHERE i.student_id = $1::uuid 
            ORDER BY p.payment_date DESC
        `, [studentId]);

        // 4. PREPARE FINAL JSON RESPONSE
        const totalInvoiced = parseFloat(invoiceStats.rows[0].total_invoiced);
        const totalPaid = parseFloat(invoiceStats.rows[0].total_paid);

        res.json({
            student_name: student.username,
            course_name: student.course_name || 'N/A',
            batch_name: student.batch_name || 'N/A',
            total_fees: totalInvoiced,
            total_paid: totalPaid,
            balance: totalInvoiced - totalPaid,
            payments: history.rows
        });

    } catch (error) { 
        await client.query('ROLLBACK');
        console.error("Dashboard Error:", error);
        res.status(500).json({ message: 'Failed to sync student dashboard' }); 
    } finally { 
        client.release(); 
    }
});

/**
 * 3.3 PROFESSIONAL RECEIPT GENERATION (A5 Landscape - Fixed Layout)
 */
router.get('/receipt/:idOrTxn', authenticateToken, async (req, res) => {
    const { idOrTxn } = req.params;
    try {
        const isUUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(idOrTxn);
        let whereClause = isUUID ? `p.id = $1::uuid` : `p.transaction_id = $1`;

        const q = `
            SELECT 
                p.id AS payment_id, /* ADDED: Ensure p.id is fetched as fallback */
                p.transaction_id, p.amount, p.payment_date, p.payment_mode, p.remarks,
                i.invoice_number, i.total_amount as invoice_total, (i.total_amount - i.paid_amount) as due_balance,
                u.username AS student_name, 
                s.roll_number, 
                c.course_name,
                b.batch_name
            FROM ${DB.PAYMENTS} p 
            JOIN ${DB.INVOICES} i ON p.invoice_id=i.id 
            JOIN ${DB.STUDENTS} s ON i.student_id=s.student_id 
            JOIN ${DB.USERS} u ON s.user_id=u.id 
            LEFT JOIN ${DB.COURSES} c ON s.course_id=c.id 
            LEFT JOIN ${DB.BATCHES} b ON s.batch_id=b.id
            WHERE ${whereClause}
        `;
        
        const { rows } = await pool.query(q, [idOrTxn]);
        if (!rows[0]) return res.status(404).json({ message: 'Receipt Not Found' });
        const data = rows[0];

        // 1. Fetch System Configuration (FIXED: Extracting all branding data from module_config JSONB)
        const configRes = await pool.query(`
            SELECT 
                module_config ->> 'school_name' AS school_name,
                module_config ->> 'school_address' AS school_address,
                module_config ->> 'school_phone' AS school_phone,
                module_config ->> 'school_email' AS school_email,
                school_logo_path,
                currency
            FROM ${DB.SETTINGS} 
            LIMIT 1
        `);

        // The 'config' object now contains clean, usable strings extracted from JSONB.
        const config = configRes.rows[0] || {}; 

        // Define safe reference for filenames and PDF body text
        const receiptRef = data.transaction_id || data.payment_id || 'UNKNOWN';
        const currencySymbol = config.currency === 'INR' ? 'Rs.' : (config.currency || 'Rs.');

        // --- PDF SETUP ---
        const doc = new PDFDocument({ size: 'A5', layout: 'landscape', margin: 30 });
        res.setHeader('Content-Type', 'application/pdf');
        // Use safe reference for the filename
        res.setHeader('Content-Disposition', `attachment; filename=Receipt-${receiptRef}.pdf`); 
        doc.pipe(res);

        // Border
        doc.rect(20, 20, 555, 380).lineWidth(1).strokeColor('#333').stroke();

        // 1. HEADER (MOCK DATA REMOVED - Using dynamic config from JSONB)
        const headerY = 35;
        doc.fillColor('#2c3e50')
           // Use dynamic school_name (from JSONB)
           .fontSize(18).font("Helvetica-Bold").text(config.school_name || 'SCHOOL ERP SYSTEM', 40, headerY) 
           // Use dynamic address (from JSONB)
           .fontSize(9).font("Helvetica").text(config.school_address || '', 40, headerY + 20) 
           // Use dynamic contact details (from JSONB)
           .text(`Phone: ${config.school_phone || ''} | Email: ${config.school_email || ''}`, 40, headerY + 32); 

        doc.fillColor('#000')
           .fontSize(14).font("Helvetica-Bold").text('MONEY RECEIPT', 400, headerY, { width: 155, align: 'right' })
           .fontSize(9).font("Helvetica")
           .text(`Receipt No: ${receiptRef}`, 350, headerY + 20, { width: 205, align: 'right' })
           .text(`Date: ${moment(data.payment_date).format('DD-MM-YYYY')}`, 350, headerY + 32, { width: 205, align: 'right' });

        doc.moveTo(40, headerY + 50).lineTo(555, headerY + 50).lineWidth(0.5).strokeColor('#aaa').stroke();

        // 2. INFO
        const infoY = headerY + 65;
        doc.fillColor('#000');
        
        // Col 1
        doc.fontSize(10).font("Helvetica-Bold").text("Name:", 40, infoY);
        doc.font("Helvetica").text(data.student_name, 80, infoY); 
        
        // Col 2
        doc.font("Helvetica-Bold").text("Roll No:", 250, infoY);
        doc.font("Helvetica").text(data.roll_number || 'N/A', 300, infoY);
        
        // Col 3
        doc.font("Helvetica-Bold").text("Mode:", 450, infoY);
        doc.font("Helvetica").text(data.payment_mode, 490, infoY);

        doc.font("Helvetica-Bold").text("Course:", 40, infoY + 18);
        doc.font("Helvetica").text(`${data.course_name || ''} (${data.batch_name || ''})`, 85, infoY + 18);

        // 3. TABLE
        const tableTop = infoY + 45;
        doc.rect(40, tableTop, 515, 20).fillAndStroke('#f0f0f0', '#ccc');
        doc.fillColor('black').fontSize(9).font("Helvetica-Bold");
        
        doc.text("SL", 50, tableTop + 5);
        doc.text("DESCRIPTION", 100, tableTop + 5);
        doc.text(`AMOUNT (${config.currency || 'INR'})`, 450, tableTop + 5, { width: 95, align: 'right' });

        // Row
        const rowY = tableTop + 25;
        const amountPaid = parseFloat(data.amount).toFixed(2);
        const dueBalance = parseFloat(data.due_balance).toFixed(2);
        
        doc.font("Helvetica").fontSize(10);
        doc.text("01", 50, rowY);
        doc.text(`Payment received against Invoice ${data.invoice_number}`, 100, rowY);
        doc.font("Helvetica-Bold").text(amountPaid, 450, rowY, { width: 95, align: 'right' });

        doc.moveTo(40, rowY + 20).lineTo(555, rowY + 20).lineWidth(0.5).stroke();

        // 4. TOTALS 
        const totalY = rowY + 35;
        
        // Label Column
        doc.fontSize(12).font("Helvetica-Bold")
           .text("GRAND TOTAL:", 300, totalY, { width: 140, align: 'right' });
        
        // Amount Column (Separate X position)
        doc.text(`${currencySymbol} ${amountPaid}`, 450, totalY, { width: 95, align: 'right' });

        // Due Balance (Below Total)
        doc.fontSize(9).font("Helvetica").fillColor('#e74c3c')
           .text(`(Remaining Due: ${currencySymbol} ${dueBalance})`, 40, totalY + 5);

        // 5. FOOTER
        const sigY = 300; 

        doc.fillColor('black').lineWidth(1);
        doc.moveTo(60, sigY).lineTo(180, sigY).stroke();
        doc.fontSize(8).text("Depositor Signature", 60, sigY + 5, { width: 120, align: 'center' });

        doc.moveTo(400, sigY).lineTo(520, sigY).stroke();
        doc.text("Authorized Signature", 400, sigY + 5, { width: 120, align: 'center' });

        doc.fontSize(7).fillColor('#888')
           .text(`Generated on ${moment().format('DD-MMM-YYYY HH:mm A')}`, 20, 360, { align: 'center', width: 555 }); 

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

// 4.3 LATE FEE CONFIG (CRUD)
router.get('/late-fee-config/current', authenticateToken, async (req, res) => {
    try { const r = await pool.query(`SELECT * FROM ${DB.LATE_FEE} LIMIT 1`); res.json(r.rows[0] || {}); } catch (e) { res.status(500).json({message:'Error'}); }
});

router.post('/late-fee-config', authenticateToken, authorize(['admin']), async (req, res) => {
    try { 
        await pool.query(`DELETE FROM ${DB.LATE_FEE}`); 
        const r = await pool.query(`INSERT INTO ${DB.LATE_FEE} (grace_days, penalty_type, penalty_value, max_penalty_value, compounding_interval) VALUES ($1, $2, $3, $4, $5) RETURNING *`, [req.body.grace_days, req.body.penalty_type, req.body.penalty_value, req.body.max_penalty_value, req.body.compounding_interval]); 
        res.json(r.rows[0]); 
    } catch (e) { res.status(500).json({message:'Error'}); }
});

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

/**
 * 5.1 TRANSACTION HISTORY (Branch-Aware Version)
 * @route   GET /api/finance/history
 * @desc    Fetch payment logs with date filtering and multi-branch isolation
 * @access  Private (Admin, Super Admin, Finance)
 */
router.get('/history', authenticateToken, authorize(['admin', 'super admin', 'finance']), async (req, res) => {
    // 1. EXTRACTION: Identify the user's scope from the JWT token
    const { branch_id, role } = req.user; 
    
    // 2. FILTERS: Default to current month if no dates are provided
    const { startDate, endDate } = req.query;
    const start = startDate || moment().startOf('month').format('YYYY-MM-DD');
    const end = endDate || moment().endOf('month').format('YYYY-MM-DD');

    try {
        // 3. BASE SQL: Joins Payments -> Invoices -> Students to reach the branch_id
        let query = `
            SELECT 
                p.id AS payment_id,  
                p.transaction_id, 
                p.amount, 
                p.payment_date, 
                p.payment_mode, 
                u.username AS student_name,
                s.roll_number,
                c.course_name
            FROM ${DB.PAYMENTS} p 
            JOIN ${DB.INVOICES} i ON p.invoice_id = i.id 
            JOIN ${DB.STUDENTS} s ON i.student_id = s.student_id 
            JOIN ${DB.USERS} u ON s.user_id = u.id
            LEFT JOIN ${DB.COURSES} c ON s.course_id = c.id
            WHERE p.payment_date::date >= $1 AND p.payment_date::date <= $2
        `;

        const params = [start, end];

        // 4. MULTI-TENANCY SECURITY: 
        // If not a Super Admin, append a branch filter to isolate data.
        if (role !== 'super admin' && branch_id) {
            query += ` AND s.branch_id = $3::uuid`; 
            params.push(branch_id);
        }

        query += ` ORDER BY p.payment_date DESC`;
        
        const result = await pool.query(query, params);
        
        // 5. RESPONSE: Return rows or an empty array if no records found
        res.status(200).json(result.rows);

    } catch (error) { 
        console.error("History API Error:", error.message);
        res.status(500).json({ 
            message: 'Failed to fetch transaction history.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined 
        }); 
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
    const start = `${year}-04-01`; 
    const end = `${year+1}-03-31`;

    try {
        // 1. Fetch Configured Targets
        const targets = await pool.query(`
            SELECT c.name, b.budget_amount, c.type 
            FROM ${DB.BUDGETS} b 
            JOIN ${DB.BUDGET_CATS} c ON b.category_id=c.id 
            WHERE b.fiscal_year=$1
        `, [year]);
        
        let reportData = targets.rows.map(t => ({
            name: t.name,
            budgeted: parseFloat(t.budget_amount || 0),
            type: t.type,
            actual: 0 
        }));

        // 2. Calculate & Merge Actual Income
        const incomeRes = await pool.query(`
            SELECT COALESCE(SUM(amount), 0) as val 
            FROM ${DB.PAYMENTS} 
            WHERE payment_date BETWEEN $1 AND $2
        `, [start, end]);
        
        const totalIncome = parseFloat(incomeRes.rows[0].val);

        let incomeEntry = reportData.find(d => d.type === 'Income');
        
        if (incomeEntry) {
            incomeEntry.actual = totalIncome;
        } else if (totalIncome > 0) {
            reportData.push({ name: 'Tuition Fee Collection', budgeted: 0, type: 'Income', actual: totalIncome });
        }

        // 3. Calculate & Merge Actual Expenses
        const expenseRes = await pool.query(`
            SELECT c.name, SUM(e.amount) as val 
            FROM ${DB.EXPENSES} e 
            JOIN ${DB.BUDGET_CATS} c ON e.category_id=c.id 
            WHERE e.expense_date BETWEEN $1 AND $2 
            GROUP BY c.name
        `, [start, end]);

        expenseRes.rows.forEach(exp => {
            const val = parseFloat(exp.val);
            let item = reportData.find(d => d.name === exp.name && d.type === 'Expense');
            
            if (item) {
                item.actual = val;
            } else {
                reportData.push({ name: exp.name, budgeted: 0, type: 'Expense', actual: val });
            }
        });

        res.json({ year, report: reportData });

    } catch (e) { 
        console.error("Budget Report Error:", e);
        res.status(500).json({ message: 'Error generating report' }); 
    }
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
//**
 //* 5.6 DASHBOARD QUICK STATS (Branch-Aware & Secure)
 //*// ড্যাশবোর্ডে শুধু আপনার ব্রাঞ্চের বকেয়া টাকা দেখাবে
 //*//
router.get('/reports/dashboard-stats', authenticateToken, authorize(FEE_ROLES), async (req, res) => {
    const { branch_id, role } = req.user;

    try {
        let query = `
            SELECT 
                COUNT(i.id)::int AS unpaid_count,
                COALESCE(SUM(i.total_amount - i.paid_amount), 0)::float AS total_outstanding
            FROM ${DB.INVOICES} i
            JOIN ${DB.STUDENTS} s ON i.student_id = s.student_id
            WHERE i.status NOT IN ('Paid', 'Waived')
        `;

        const params = [];
        // 🛡️ ব্রাঞ্চ সিকিউরিটি ফিল্টার
        if (role !== 'super admin' && branch_id) {
            query += ` AND s.branch_id = $1::uuid`;
            params.push(branch_id);
        }

        const result = await pool.query(query, params);
        res.status(200).json(result.rows[0]);
    } catch (e) {
        console.error("Dashboard Stats Error:", e);
        res.status(500).json({ message: 'Failed to fetch statistics.' });
    }
});
/**
 * 5.8 DETAILED STUDENT DUES REPORT (Strict Branch Isolation)
 * এই রিপোর্টটি এখন শুধু আপনার ব্রাঞ্চের (WB02) স্টুডেন্টদেরই দেখাবে
 */
router.get('/reports/student-dues', authenticateToken, authorize(['admin', 'finance', 'super admin']), async (req, res) => {
    const { branch_id, role } = req.user;
    const { course_id, search } = req.query;

    try {
        let query = `
            SELECT 
                s.student_id,
                s.roll_number, 
                u.username AS student_name, 
                c.course_name,
                COALESCE(SUM(i.total_amount), 0)::float AS total_billed,
                COALESCE(SUM(i.paid_amount), 0)::float AS total_paid,
                (COALESCE(SUM(i.total_amount), 0) - COALESCE(SUM(i.paid_amount), 0))::float AS balance_due
            FROM ${DB.STUDENTS} s
            JOIN ${DB.USERS} u ON s.user_id = u.id
            LEFT JOIN ${DB.COURSES} c ON s.course_id = c.id
            LEFT JOIN ${DB.INVOICES} i ON s.student_id = i.student_id AND i.status != 'Waived'
            WHERE u.is_active = TRUE
        `;

        const params = [];
        let paramIndex = 1;

        // 🛡️ এটিই অন্য ব্রাঞ্চের স্টুডেন্টদের আসা আটকাবে
        if (role !== 'super admin' && branch_id) {
            query += ` AND s.branch_id = $${paramIndex++}::uuid`;
            params.push(branch_id);
        }

        if (course_id && course_id !== 'all') {
            query += ` AND s.course_id = $${paramIndex++}::uuid`;
            params.push(course_id);
        }

        if (search) {
            query += ` AND (LOWER(u.username) LIKE $${paramIndex} OR LOWER(s.roll_number) LIKE $${paramIndex})`;
            params.push(`%${search.toLowerCase()}%`);
            paramIndex++;
        }

        query += `
            GROUP BY s.student_id, u.username, s.roll_number, c.course_name
            HAVING (COALESCE(SUM(i.total_amount), 0) - COALESCE(SUM(i.paid_amount), 0)) > 0
            ORDER BY balance_due DESC
        `;

        const result = await pool.query(query, params);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Dues Report Error:', error);
        res.status(500).json({ message: 'Internal Server Error' });
    }
});
// 5.7 STUDENT LEDGER REPORT 
router.get('/ledger/:studentId', authenticateToken, authorize(FEE_ROLES), async (req, res) => {
    const { studentId } = req.params;
    
    try {
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
                    issue_date::timestamp AS sort_date 
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
                    p.payment_date::timestamp AS sort_date 
                FROM ${DB.PAYMENTS} p
                JOIN ${DB.INVOICES} i ON p.invoice_id = i.id
                WHERE i.student_id = $1::uuid
            ) combined_data
            ORDER BY sort_date ASC;
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

/**
 * 5.8 DETAILED STUDENT DUES REPORT (Optimized & Branch Locked)
 * @route   GET /api/finance/reports/student-dues
 * @desc    Generates a list of students with outstanding balances, restricted by branch.
 * @access  Private (Admin, Finance, Super Admin)
 */
router.get('/reports/student-dues', authenticateToken, authorize(['admin', 'finance', 'super admin']), async (req, res) => {
    // 1. EXTRACTION: Get User's branch_id and role from the decoded JWT token
    const { branch_id, role } = req.user;
    const { course_id, search } = req.query;

    try {
        // 2. BASE SQL: Aggregates billing and payments using direct branch_id filtering from the Invoices table
        let query = `
            SELECT 
                s.student_id,
                s.roll_number, 
                u.username AS student_name, 
                c.course_name,
                COALESCE(SUM(i.total_amount), 0)::float AS total_billed,
                COALESCE(SUM(i.paid_amount), 0)::float AS total_paid,
                (COALESCE(SUM(i.total_amount), 0) - COALESCE(SUM(i.paid_amount), 0))::float AS balance_due,
                MAX(p.payment_date) AS last_payment_date
            FROM ${DB.STUDENTS} s
            JOIN ${DB.USERS} u ON s.user_id = u.id
            LEFT JOIN ${DB.COURSES} c ON s.course_id = c.id
            -- Joining Invoices using the specific branch_id column confirmed in your schema
            LEFT JOIN ${DB.INVOICES} i ON s.student_id = i.student_id 
               AND i.status != 'Waived'
            LEFT JOIN ${DB.PAYMENTS} p ON i.id = p.invoice_id
            WHERE u.is_active = TRUE
        `;

        const params = [];
        let paramIndex = 1;

        // 3. 🛡️ SECURITY FILTER (Multi-Tenancy)
        // This ensures a Branch Admin only sees invoices belonging to their specific branch_id.
        if (role !== 'super admin' && branch_id) {
            query += ` AND i.branch_id = $${paramIndex++}::uuid`;
            params.push(branch_id);
        }

        // 4. OPTIONAL FILTERS: Course and Search
        if (course_id && course_id !== 'all') {
            query += ` AND s.course_id = $${paramIndex++}::uuid`;
            params.push(course_id);
        }

        if (search) {
            query += ` AND (LOWER(u.username) LIKE $${paramIndex} OR LOWER(s.roll_number) LIKE $${paramIndex})`;
            params.push(`%${search.toLowerCase()}%`);
            paramIndex++;
        }

        // 5. GROUPING & HAVING: Display only students with a balance greater than 0
        query += `
            GROUP BY s.student_id, u.username, s.roll_number, c.course_name
            HAVING (COALESCE(SUM(i.total_amount), 0) - COALESCE(SUM(i.paid_amount), 0)) > 0
            ORDER BY balance_due DESC
        `;

        const result = await pool.query(query, params);
        res.status(200).json(result.rows);

    } catch (error) {
        console.error('Database Report Error:', error.message);
        res.status(500).json({ message: 'Failed to generate branch-specific dues report.' });
    }
});

// 5.9 GENERAL LEDGER EXPORT
router.get('/reports/gl-export', authenticateToken, authorize(['admin', 'finance', 'super admin']), async (req, res) => {
    const { startDate, endDate } = req.query;
    const start = startDate || moment().startOf('year').format('YYYY-MM-DD');
    const end = endDate || moment().endOf('year').format('YYYY-MM-DD');

    try {
        const query = `
            SELECT * FROM (
                -- 1. INCOME (Credit)
                SELECT 
                    payment_date AS date,
                    'Income' AS type,
                    'Fee Collection' AS category,
                    ('Ref: ' || transaction_id) AS description,
                    amount AS credit,
                    0.00 AS debit
                FROM ${DB.PAYMENTS}
                WHERE payment_date::date >= $1 AND payment_date::date <= $2

                UNION ALL

                -- 2. EXPENSES (Debit)
                SELECT 
                    e.expense_date AS date,
                    'Expense' AS type,
                    c.name AS category,
                    e.description,
                    0.00 AS credit,
                    e.amount AS debit
                FROM ${DB.EXPENSES} e
                LEFT JOIN ${DB.BUDGET_CATS} c ON e.category_id = c.id
                WHERE e.expense_date::date >= $1 AND e.expense_date::date <= $2
            ) ledger_data
            ORDER BY date DESC
        `;

        const result = await pool.query(query, [start, end]);
        res.status(200).json(result.rows);

    } catch (error) {
        console.error('GL Export Error:', error);
        res.status(500).json({ message: 'Failed to generate GL report.' });
    }
});

// =========================================================
// SECTION 6: INSTITUTIONAL UTILITIES (WAIVERS, DEFAULTERS, REMINDERS)
// =========================================================

/**
 * 6.1 FETCH WAIVER REQUEST REGISTRY
 * @route   GET /api/finance/waiver-requests
 */
router.get('/waiver-requests', authenticateToken, authorize(FEE_ROLES), async (req, res) => {
    try { 
        const result = await pool.query(`SELECT * FROM ${DB.WAIVERS} ORDER BY request_date DESC`); 
        res.json(result.rows); 
    } catch (e) { 
        res.status(500).json({ message: 'Institutional Registry Error: Failed to fetch waivers.' }); 
    }
});

/**
 * @route   PUT /api/finance/waiver-requests/:requestId/status
 * @desc    Updates waiver status and synchronizes student ledger totals.
 */
router.put('/waiver-requests/:requestId/status', authenticateToken, authorize(['admin', 'super admin']), async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { requestId } = req.params; 
        const { newStatus, amount } = req.body;
        
        await client.query(`UPDATE ${DB.WAIVERS} SET status=$1, processed_by=$2::uuid WHERE id=$3::uuid`, [newStatus, req.user.id, requestId]);
        
        if (newStatus === 'Approved' && amount > 0) {
            const wRes = await client.query(`SELECT student_id FROM ${DB.WAIVERS} WHERE id=$1::uuid`, [requestId]);
            const inv = await client.query(`SELECT id FROM ${DB.INVOICES} WHERE student_id=$1::uuid AND status!='Paid' LIMIT 1`, [wRes.rows[0].student_id]);
            
            if (inv.rows[0]) {
                await client.query(`
                    UPDATE ${DB.INVOICES} 
                    SET total_amount = total_amount - $1, 
                        discount_amount = COALESCE(discount_amount, 0) + $1 
                    WHERE id = $2::uuid`, 
                [amount, inv.rows[0].id]);
            }
        }
        
        await client.query('COMMIT'); 
        res.json({ success: true, message: `Institutional Waiver ${newStatus} successfully.` });
    } catch (e) { 
        await client.query('ROLLBACK'); 
        res.status(500).json({ message: "Waiver processing failure: " + e.message }); 
    } finally { 
        client.release(); 
    }
});

/**
 * 6.2 DEFAULTERS REGISTRY (Updated with Email Telemetry)
 */
router.get('/defaulters', authenticateToken, authorize(['admin', 'finance', 'super admin']), async (req, res) => {
    const { branch_id, role } = req.user;

    try {
        let query = `
            SELECT 
                s.student_id, 
                u.username AS student_name,
                COALESCE(u.email, s.email, 'NOT PROVIDED') AS email, -- ✅ ADDED THIS LINE
                COALESCE(s.enrollment_no, s.roll_number, s.admission_id, 'PENDING') AS roll_number, 
                COALESCE(u.phone_number, s.phone_number, 'NOT PROVIDED') AS parent_phone, 
                s.last_finance_reminder_sent,
                c.course_name, 
                b.batch_name,                    
                COUNT(i.id)::int AS pending_invoices_count, 
                SUM(i.total_amount - i.paid_amount)::float AS total_due
            FROM ${DB.INVOICES} i
            JOIN ${DB.STUDENTS} s ON i.student_id = s.student_id
            JOIN ${DB.USERS} u ON s.user_id = u.id
            LEFT JOIN ${DB.COURSES} c ON s.course_id = c.id
            LEFT JOIN ${DB.BATCHES} b ON s.batch_id = b.id
            WHERE i.status NOT IN ('Paid', 'Waived')
        `;

        const params = [];
        if (role.toLowerCase() !== 'super admin' && branch_id) {
            query += ` AND s.branch_id = $1::uuid`;
            params.push(branch_id);
        }

        // ⚠️ CRITICAL: You MUST add u.email and s.email to the GROUP BY clause
        query += `
            GROUP BY 
                s.student_id, u.username, u.email, s.email, s.enrollment_no, 
                s.roll_number, s.admission_id, u.phone_number, s.phone_number,
                s.last_finance_reminder_sent, c.course_name, b.batch_name
            HAVING SUM(i.total_amount - i.paid_amount) > 0
            ORDER BY total_due DESC
        `;
        
        const result = await pool.query(query, params);
        res.status(200).json(result.rows);

    } catch (error) {
        console.error('Institutional Defaulter Sync Failure:', error.message);
        res.status(500).json({ success: false, message: 'Defaulter telemetry synchronization failure.' });
    }
});
/**
 * 6.3 FINANCE AUDIT LOGS
 * @desc Comprehensive history of payment collections and billing events.
 */
router.get('/audit-logs', authenticateToken, authorize(['admin', 'super admin', 'finance']), async (req, res) => {
    const { startDate, endDate } = req.query;
    const start = startDate || moment().startOf('month').format('YYYY-MM-DD');
    const end = endDate || moment().endOf('month').format('YYYY-MM-DD');

    try {
        const query = `
            SELECT * FROM (
                SELECT 
                    p.payment_date AS timestamp, 'PAYMENT_COLLECTED' AS action_type, u.username AS performed_by,
                    ('Collected ₹' || COALESCE(p.amount::text, '0') || ' from ' || COALESCE(s.first_name, 'Student') || ' ' || COALESCE(s.last_name, '') || ' (ID: ' || COALESCE(s.roll_number, 'N/A') || ') via ' || COALESCE(p.payment_mode, 'Unknown')) AS details,
                    p.transaction_id AS reference_id
                FROM ${DB.PAYMENTS} p
                JOIN ${DB.USERS} u ON p.collected_by = u.id
                JOIN ${DB.INVOICES} i ON p.invoice_id = i.id
                JOIN ${DB.STUDENTS} s ON i.student_id = s.student_id
                WHERE p.payment_date::date >= $1 AND p.payment_date::date <= $2

                UNION ALL

                SELECT 
                    i.created_at AS timestamp, 'INVOICE_GENERATED' AS action_type, u.username AS performed_by,
                    ('Generated Bill of ₹' || COALESCE(i.total_amount::text, '0') || ' for ' || COALESCE(s.first_name, 'Student') || ' ' || COALESCE(s.last_name, '') || ' (ID: ' || COALESCE(s.roll_number, 'N/A') || ')') AS details,
                    i.invoice_number AS reference_id
                FROM ${DB.INVOICES} i
                JOIN ${DB.USERS} u ON i.created_by = u.id
                JOIN ${DB.STUDENTS} s ON i.student_id = s.student_id
                WHERE i.created_at::date >= $1 AND i.created_at::date <= $2
            ) audit_data ORDER BY timestamp DESC
        `;
        const result = await pool.query(query, [start, end]);
        res.status(200).json(result.rows);
    } catch (error) {
        res.status(500).json({ message: 'Failed to synchronize institutional audit logs.' });
    }
});

/**
 * 6.4 BROADCAST DUES REMINDERS (Nodemailer Integration & Registry Stamping)
 * @route   POST /api/finance/reminders/send
 * @desc    Dispatches institutional email reminders, logs status, and updates last notified timestamp.
 * @access  Private (Admin, Finance, and Super Admin)
 */
router.post('/reminders/send', authenticateToken, authorize(['admin', 'finance', 'super admin']), async (req, res) => {
    const { studentIds } = req.body;

    if (!studentIds || !Array.isArray(studentIds) || studentIds.length === 0) {
        return res.status(400).json({ success: false, message: "Recipient selection required." });
    }

    try {
        // 1. Fetch Contact Intelligence & Outstanding Balances
        const query = `
            SELECT s.student_id, u.username AS student_name, u.email,
            COALESCE(s.enrollment_no, s.roll_number, 'N/A') as roll_number,
            (SELECT SUM(total_amount - paid_amount) FROM ${DB.INVOICES} WHERE student_id = s.student_id AND status != 'Paid') as balance
            FROM ${DB.STUDENTS} s JOIN ${DB.USERS} u ON s.user_id = u.id
            WHERE s.student_id = ANY($1::uuid[])
        `;
        const { rows } = await pool.query(query, [studentIds]);

        const telemetry = [];
        for (const student of rows) {
            if (!student.email) {
                telemetry.push({ id: student.student_id, status: 'Skipped (Missing Email)' });
                continue;
            }

            const mailOptions = {
                from: `"Institutional Finance Office" <${process.env.EMAIL_USER}>`,
                to: student.email,
                subject: `URGENT: Outstanding Arrears Notification - ${student.student_name}`,
                html: `
                    <div style="font-family: sans-serif; border: 1px solid #e5e7eb; padding: 25px; border-radius: 12px; max-width: 600px;">
                        <h2 style="color: #4f46e5;">Institutional Payment Reminder</h2>
                        <p>Dear Parent/Guardian,</p>
                        <p>This is a formal notification regarding the outstanding arrears for <b>${student.student_name}</b> (ID: ${student.roll_number}).</p>
                        <div style="background-color: #fef2f2; padding: 20px; border-radius: 10px; margin: 25px 0; border-left: 6px solid #ef4444;">
                            <p style="margin: 0; color: #991b1b; font-weight: bold; font-size: 16px;">
                                Net Outstanding Arrears: ₹${parseFloat(student.balance).toLocaleString('en-IN')}
                            </p>
                        </div>
                        <p>Please clear these dues immediately via the Student Portal HUD Hub.</p>
                        <a href="https://portal.bcsm.org.in" style="background-color: #4f46e5; color: white; padding: 12px 25px; text-decoration: none; border-radius: 50px; display: inline-block; font-weight: bold;">SYNC LEDGER & PAY NOW</a>
                        <hr style="border: 0; border-top: 1px solid #eee; margin: 30px 0;">
                        <p style="font-size: 10px; color: #6b7280; text-align: center;">Institutional Finance Registry | 2026 Telemetry Node</p>
                    </div>`
            };

            try {
                // ✅ DISPATCH: Calling your existing Nodemailer service
                await transporter.sendMail(mailOptions); 
                
                // ✅ TELEMETRY STAMP: Update the student's last notified timestamp in the registry
                await pool.query(
                    `UPDATE ${DB.STUDENTS} SET last_finance_reminder_sent = CURRENT_TIMESTAMP WHERE student_id = $1`,
                    [student.student_id]
                );

                // ✅ AUDIT: Logging success in your DB 'email_logs' table
                await pool.query(
                    `INSERT INTO email_logs (recipient_email, subject, status, reference_id) VALUES ($1, $2, 'Success', $3)`,
                    [student.email, mailOptions.subject, student.student_id]
                );

                console.log(`✅ Telemetry Sync: Notification dispatched and stamped for ${student.email}`);
                telemetry.push({ id: student.student_id, status: 'Sent' });
            } catch (err) {
                // ✅ FAILURE LOGGING
                await pool.query(
                    `INSERT INTO email_logs (recipient_email, subject, status, error_message, reference_id) VALUES ($1, $2, 'Failed', $3, $4)`,
                    [student.email, mailOptions.subject, err.message, student.student_id]
                );
                telemetry.push({ id: student.student_id, status: 'Failed' });
            }
        }

        res.status(200).json({ success: true, message: "Institutional broadcast processed.", results: telemetry });

    } catch (error) {
        console.error("Broadcast telemetry sync failed:", error.message);
        res.status(500).json({ success: false, message: "Broadcast telemetry sync failed." });
    }
});

/**
 * 3.4 GET STUDENT RECEIPTS (Production Version)
 * @route   GET /api/finance/student/receipts
 */
router.get('/student/receipts', authenticateToken, async (req, res) => {
    try {
        const studentId = req.query.student_id; 

        // Tactical Guard: Check for empty or malformed ID
        if (!studentId || studentId === 'null') {
            return res.status(200).json([]); // Return empty list, not 404
        }

        // Optimized Query using the direct student_id column confirmed in your schema
        const query = `
            SELECT 
                p.id, 
                p.amount, 
                p.payment_date, 
                p.payment_mode, 
                p.transaction_id, 
                i.invoice_number,
                COALESCE(i.title, 'General Academic Fee') as fee_type
            FROM fee_payments p
            LEFT JOIN student_invoices i ON p.invoice_id = i.id
            WHERE p.student_id = $1::uuid
            ORDER BY p.payment_date DESC;
        `;

        const result = await pool.query(query, [studentId.trim()]);
        
        // Success: Always send back the rows array
        res.status(200).json(result.rows); 

    } catch (err) {
        console.error("🔥 Telemetry Sync Error:", err.message);
        res.status(500).json({ success: false, message: "Database link error." });
    }
});
// ==========================================
// GET: Student Payment History
// ==========================================
// If putting this in server.js, change router.get to app.get and ensure URL is '/api/student/payment-history'
router.get('/student/payment-history', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;

        // 1. Get Student ID
        const studentRes = await pool.query('SELECT student_id FROM students WHERE user_id = $1', [userId]);
        if (studentRes.rows.length === 0) return res.status(404).json({ message: "Student not found" });
        const studentId = studentRes.rows[0].student_id;

        // 2. Fetch Fee Records
        // We use your actual DB columns: tuition_fee, amount_paid, due_date, status
        const query = `
            SELECT 
                id,
                tuition_fee as total_amount,
                amount_paid,
                (tuition_fee - amount_paid) as balance,
                due_date,
                status,
                updated_at as payment_date
            FROM fee_records 
            WHERE student_id = $1
            ORDER BY created_at DESC`;

        const historyRes = await pool.query(query, [studentId]);
        res.json(historyRes.rows);

    } catch (err) {
        console.error("Payment History Error:", err);
        res.status(500).json({ message: "Server error fetching history" });
    }
});

// ==========================================
// CUSTOM ROUTE: Student Fee Receipts List
// ==========================================
// Note: Path becomes /api/finance/student/receipts
router.get('/student/receipts', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        
        // 1. Get Student ID
        const studentRes = await pool.query('SELECT student_id FROM students WHERE user_id = $1', [userId]);
        if (studentRes.rows.length === 0) return res.status(404).json({ message: "Student not found" });
        const studentId = studentRes.rows[0].student_id;

        // 2. Fetch Successful Payments (Receipts)
        const query = `
            SELECT 
                fp.id,
                fp.transaction_id,
                fp.payment_date,
                fp.amount,
                fp.payment_mode,
                fp.remarks,
                si.invoice_number,
                si.title as fee_type
            FROM fee_payments fp
            JOIN student_invoices si ON fp.invoice_id = si.id
            WHERE si.student_id = $1
            ORDER BY fp.payment_date DESC`;

        const receipts = await pool.query(query, [studentId]);
        res.json(receipts.rows);

    } catch (err) {
        console.error("Receipt Fetch Error:", err);
        res.status(500).json({ message: "Server error fetching receipts" });
    }
});

// routes/fees.js

/**
 * FINAL FIX: Single Receipt Details & PDF Generation
 * Handles both Internal UUIDs and Cashfree Transaction Strings
 */
router.get('/receipt/:id', async (req, res) => {
    // 1. Get token from header or query string
    const token = req.headers.authorization?.split(' ')[1] || req.query.token;
    if (!token) return res.status(401).json({ message: 'Unauthorized' });

    try {
        const jwt = require('jsonwebtoken');
        jwt.verify(token, process.env.JWT_SECRET);

        const { id } = req.params;
        
        // 2. Identify if the incoming ID is a UUID or a Cashfree String
        const isUUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(id);

        // 3. Conditional SQL query to avoid 'invalid input syntax for type uuid'
        const query = `
            SELECT 
                fp.id, fp.transaction_id, fp.payment_date, fp.amount, fp.payment_mode,
                s.first_name, s.last_name, s.enrollment_no, s.roll_number,
                c.course_name,
                si.invoice_number, 
                si.title as fee_description
            FROM fee_payments fp
            JOIN student_invoices si ON fp.invoice_id = si.id
            JOIN students s ON si.student_id = s.student_id
            LEFT JOIN courses c ON s.course_id = c.id
            WHERE ${isUUID ? 'fp.id = $1::uuid' : 'fp.transaction_id = $1'}
        `;

        const result = await pool.query(query, [id]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ message: "Receipt record not found." });
        }

        const data = result.rows[0];

        // 4. Generate PDF if it's a browser download (has token in query)
        if (req.query.token) {
            const doc = new PDFDocument({ margin: 50 });
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename=Receipt_${data.transaction_id || 'Fee'}.pdf`);
            doc.pipe(res);

            doc.fontSize(20).text('FEE PAYMENT RECEIPT', { align: 'center' }).moveDown();
            doc.fontSize(12).text(`Transaction ID: ${data.transaction_id || data.id}`);
            doc.text(`Date: ${new Date(data.payment_date).toLocaleDateString()}`).moveDown();
            doc.text(`Student Name: ${data.first_name} ${data.last_name}`);
            doc.text(`Amount Paid: INR ${data.amount}`);
            doc.text(`Payment Mode: ${data.payment_mode}`);
            doc.end();
        } else {
            res.json(data);
        }

    } catch (err) {
        console.error("Receipt System Error:", err.message);
        res.status(500).json({ message: "Internal Server Error" });
    }
});
// ==========================================
// GET: Specific Student's Scholarships / Waivers (Schema Fixed)
// ==========================================
router.get('/student/:studentId/scholarships', authenticateToken, async (req, res) => {
    try {
        const { studentId } = req.params;

        const query = `
            SELECT 
                id, 
                request_date, 
                requested_amount AS amount,   -- Mapped DB column to API field
                reason AS scholarship_name,   -- Using reason as the name
                fee_type,                     -- Added fee_type for reference
                status,
                request_date AS created_at    -- Mapped request_date to created_at
            FROM fee_waiver_requests
            WHERE student_id = $1
            ORDER BY request_date DESC
        `;

        const result = await pool.query(query, [studentId]);
        res.json(result.rows);

    } catch (err) {
        console.error("Scholarship Fetch Error:", err);
        res.status(500).json({ message: "Server error fetching scholarships" });
    }
});


// --- DEPENDENCIES ---
// Ensure these are at the VERY TOP of your routes/fees.js file
 
const { sendPaymentEmail } = require('../utils/mailer'); 

/**
 * 1. CREATE CASHFREE ORDER
 * @route   POST /api/finance/create-cashfree-order
 * @desc    Initializes a payment session with Cashfree Sandbox
 */
router.post('/create-cashfree-order', authenticateToken, async (req, res) => {
    try {
        const { amount, studentId } = req.body;

        // Fetch Student/User details from DB for the Cashfree payload
        const userRes = await pool.query(`
            SELECT u.email, u.phone_number, u.username 
            FROM users u 
            JOIN students s ON s.user_id = u.id 
            WHERE s.student_id = $1::uuid`, [studentId]);
        
        const user = userRes.rows[0] || {};

        // Request a real Session ID from Cashfree Sandbox using .env credentials
        const response = await axios.post(
            'https://sandbox.cashfree.com/pg/orders',
            {
                order_amount: parseFloat(amount).toFixed(2),
                order_currency: "INR",
                order_id: `ORDER_${Date.now()}`, 
                customer_details: {
                    customer_id: studentId,
                    customer_email: user.email || 'guest@example.com',
                    customer_phone: user.phone_number || '9999999999'
                },
                order_meta: {
                    // Redirects to success page which triggers verification
                    return_url: "http://localhost:3005/payment-success.html?order_id={order_id}"
                }
            },
            {
                headers: {
                    'x-client-id': process.env.CASHFREE_APP_ID, 
                    'x-client-secret': process.env.CASHFREE_SECRET_KEY, 
                    'x-api-version': '2023-08-01',
                    'Content-Type': 'application/json'
                }
            }
        );

        res.status(200).json({
            payment_session_id: response.data.payment_session_id,
            order_id: response.data.order_id
        });

    } catch (error) {
        console.error("Cashfree Order Error:", error.response?.data || error.message);
        res.status(500).json({ message: "Failed to create payment order" });
    }
});

/**
 * 2. VERIFY PAYMENT & UPDATE DATABASE
 * @route   GET /api/finance/verify-payment/:orderId
 * @desc    Verifies status, updates invoices, records payment, and emails student
 */
router.get('/verify-payment/:orderId', authenticateToken, async (req, res) => {
    const { orderId } = req.params;
    const client = await pool.connect();

    try {
        // 1. Verify status with Cashfree
        const cfResponse = await axios.get(
            `https://sandbox.cashfree.com/pg/orders/${orderId}`,
            {
                headers: {
                    'x-client-id': process.env.CASHFREE_APP_ID,
                    'x-client-secret': process.env.CASHFREE_SECRET_KEY,
                    'x-api-version': '2023-08-01'
                }
            }
        );

        if (cfResponse.data.order_status === 'PAID') {
            const { order_amount, cf_order_id, customer_details } = cfResponse.data;
            const studentId = customer_details.customer_id;

            await client.query('BEGIN');

            // 2. DB UPDATE: Find the oldest pending invoice
            const invoiceRes = await client.query(
                `SELECT id, total_amount, paid_amount FROM student_invoices 
                 WHERE student_id = $1::uuid AND status != 'Paid' 
                 ORDER BY due_date ASC LIMIT 1`, 
                [studentId]
            );

            if (invoiceRes.rows.length > 0) {
                const invoice = invoiceRes.rows[0];
                
                // Record the payment
                await client.query(
                    `INSERT INTO fee_payments (invoice_id, amount, payment_mode, transaction_id, remarks) 
                     VALUES ($1, $2, 'Online', $3, 'Cashfree Payment Successful')`,
                    [invoice.id, order_amount, cf_order_id]
                );

                // Update invoice status
                const newPaidAmount = parseFloat(invoice.paid_amount) + parseFloat(order_amount);
                const newStatus = (newPaidAmount >= (parseFloat(invoice.total_amount) - 0.01)) ? 'Paid' : 'Partial';

                await client.query(
                    `UPDATE student_invoices SET paid_amount = $1, status = $2 WHERE id = $3`,
                    [newPaidAmount, newStatus, invoice.id]
                );
            }

            // 3. Get User details for email
            const userRes = await client.query(
                `SELECT u.email, u.username FROM users u 
                 JOIN students s ON s.user_id = u.id 
                 WHERE s.student_id = $1::uuid`, [studentId]
            );

            await client.query('COMMIT');

            // 4. Trigger Confirmation Email
            if (userRes.rows.length > 0) {
                const { email, username } = userRes.rows[0];
                await sendPaymentEmail(email, username, order_amount, cf_order_id);
            }

            res.status(200).json({ success: true, transactionId: cf_order_id, amount: order_amount });
        } else {
            res.status(400).json({ success: false, message: 'Payment status: ' + cfResponse.data.order_status });
        }
    } catch (error) {
        await client.query('ROLLBACK');
        console.error("Verification Error:", error.message);
        res.status(500).json({ message: 'Internal Server Error' });
    } finally {
        client.release();
    }
});

// routes/fees.js
router.get('/receipt/:idOrTxn', async (req, res) => {
    // Check for token in headers OR query string
    const token = req.headers.authorization?.split(' ')[1] || req.query.token;
    
    if (!token) {
        return res.status(401).json({ message: 'Authentication required' });
    }

    try {
        // Manually verify token if it came from the query string
        const jwt = require('jsonwebtoken');
        jwt.verify(token, process.env.JWT_SECRET);
        
        // ... Rest of your existing PDF generation logic ...
    } catch (err) {
        return res.status(403).json({ message: 'Invalid Token' });
    }
});


/**
 * @route   GET /api/finance/receipt/:id
 * @desc    Fetch receipt JSON for UI OR generate professional PDF for download
 * @access  Protected (Supports Header Auth & Query Token for Downloads)
 */
router.get('/receipt/:id', async (req, res) => {
    // 1. Unified Authentication Logic
    // Browser <a> tags cannot send headers, so we allow token via query string
    const token = req.headers.authorization?.split(' ')[1] || req.query.token;
    
    if (!token) {
        return res.status(401).json({ success: false, message: 'Unauthorized: No token provided' });
    }

    try {
        const jwt = require('jsonwebtoken');
        // Verify token validity
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const requestBy = decoded.id;

        const { id } = req.params;
        
        // 2. Data Integrity: Detect if ID is a Database UUID or a Transaction String (Cashfree/Manual)
        const isUUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(id);

        const query = `
            SELECT 
                fp.id, fp.transaction_id, fp.payment_date, fp.amount, fp.payment_mode,
                s.first_name, s.last_name, s.enrollment_no, s.roll_number,
                c.course_name, b.batch_name,
                si.invoice_number, 
                si.title as fee_description
            FROM fee_payments fp
            JOIN student_invoices i ON fp.invoice_id = i.id
            JOIN student_invoices si ON fp.invoice_id = si.id -- Double join for safety
            JOIN students s ON si.student_id = s.student_id
            LEFT JOIN courses c ON s.course_id = c.id
            LEFT JOIN batches b ON s.batch_id = b.id
            WHERE ${isUUID ? 'fp.id = $1::uuid' : 'fp.transaction_id = $1'}
            LIMIT 1
        `;

        const result = await pool.query(query, [id]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: "Receipt record not found." });
        }

        const data = result.rows[0];

        // 3. Output Logic: If 'token' is in query, user wants a PDF download
        if (req.query.token) {
            const doc = new PDFDocument({ 
                size: 'A4', 
                margin: 50,
                info: { Title: `Receipt-${data.transaction_id || data.id}` }
            });

            // Set response headers for PDF stream
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `inline; filename=Receipt_${data.transaction_id || 'Fee'}.pdf`);
            
            doc.pipe(res);

            // --- PDF STYLING & CONTENT ---
            // Header Section
            doc.fontSize(22).fillColor('#4f46e5').text('OFFICIAL FEE RECEIPT', { align: 'center' }).moveDown(0.5);
            
            // Branch/School Branding (Can be dynamic)
            doc.fontSize(10).fillColor('#64748b').text('Institution: BCSM Portal System', { align: 'left' });
            doc.text(`Receipt No: ${data.invoice_number || 'N/A'}`, { align: 'right' });
            doc.text(`Transaction ID: ${data.transaction_id || data.id}`, { align: 'right' });
            doc.text(`Date: ${new Date(data.payment_date).toLocaleDateString('en-IN')}`, { align: 'right' }).moveDown();
            
            // Visual Divider
            doc.rect(50, doc.y, 500, 2).fill('#4f46e5').moveDown(1.5);
            
            // Student Details
            doc.fillColor('#1e293b').fontSize(12).font('Helvetica-Bold')
               .text(`Student Name: ${data.first_name} ${data.last_name}`);
            doc.font('Helvetica').fontSize(10)
               .text(`Enrollment No: ${data.enrollment_no || 'N/A'}`)
               .text(`Roll Number: ${data.roll_number || 'N/A'}`)
               .text(`Course/Batch: ${data.course_name} (${data.batch_name || 'General'})`)
               .moveDown(1.5);
            
            // Payment Summary Table-like structure
            doc.rect(50, doc.y, 500, 25).fill('#f1f5f9');
            doc.fillColor('#475569').fontSize(10).font('Helvetica-Bold').text('Description', 60, doc.y - 17);
            doc.text('Amount Paid', 450, doc.y - 17, { align: 'right' });
            
            doc.moveDown(0.8).fillColor('#1e293b').font('Helvetica')
               .text(data.fee_description || 'General School Fee Payment', 60);
            doc.fontSize(12).font('Helvetica-Bold')
               .text(`INR ${parseFloat(data.amount).toLocaleString('en-IN')}`, 450, doc.y - 12, { align: 'right' });

            doc.moveDown(2);
            doc.rect(50, doc.y, 500, 1).fill('#cbd5e1').moveDown(0.5);
            
            // Footer & Verification
            doc.fontSize(14).fillColor('#16a34a').text(`Payment Status: SUCCESSFUL`, { align: 'center' }).moveDown();
            doc.fontSize(8).fillColor('#94a3b8')
               .text('This is a computer-generated receipt and does not require a physical signature.', { align: 'center' })
               .text(`Generated on: ${new Date().toLocaleString()}`, { align: 'center' });
            
            doc.end();

        } else {
            // Standard JSON response for Frontend Dashboard UI
            res.json({ success: true, data: data });
        }

    } catch (err) {
        console.error("🔥 Final Receipt API Error:", err.message);
        res.status(500).json({ success: false, message: "Internal Server Error processing receipt." });
    }
});


router.get('/student/receipts', authenticateToken, async (req, res) => {
    try {
        const studentId = req.query.student_id;
        const result = await pool.query('SELECT * FROM fee_payments WHERE student_id = $1::uuid', [studentId]);
        res.status(200).json(result.rows);
    } catch (err) {
        res.status(500).json({ error: "Finance Registry Sync Failed" });
    }
});

module.exports = router;

