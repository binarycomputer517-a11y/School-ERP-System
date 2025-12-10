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
    EXPENSES: 'expenses',
    // ✅ FIX: Corrected table name for global settings
    SETTINGS: 'erp_settings' 
};

// const BASE_TUITION_FEE = 5000.00; // Removed as Tuition is no longer billed
const FEE_ROLES = ['Admin', 'Staff', 'Super Admin', 'Finance'];

// --- Helper Functions ---
const generateInvoiceNumber = () => {
    return `INV-${moment().format('YYYYMMDD')}-${uuidv4().split('-')[0].toUpperCase().substring(0, 6)}`;
};

/**
 * Helper to calculate Issue Date and Due Date based on course duration.
 * @param {string} admissionDate - The student's admission date string (s.admission_date).
 * @param {number} durationMonths - Course duration in months (fs.course_duration_months).
 * @returns {{issueDate: string, dueDate: string}}
 */
const calculateDates = (admissionDate, durationMonths) => {
    // 1. Issue Date is the Admission Date
    const issueDate = moment(admissionDate).format('YYYY-MM-DD');
    
    // 2. Due Date calculation (7 days if short course, else 30 days)
    const daysToAdd = durationMonths <= 6 ? 7 : 30; // 7 days if 6 months or less, otherwise 30 days
    const dueDate = moment(issueDate).add(daysToAdd, 'days').format('YYYY-MM-DD');
    
    return { issueDate, dueDate };
};

// =========================================================
// SECTION 2: CORE TRANSACTIONS (INVOICING, COLLECTION, REFUND)
// =========================================================

/**
 * 2.1 FULL COURSE INVOICE GENERATION (One-Time based on Structure - BULK ADMIN TOOL)
 * FIX: Uses student's admission_date as issue_date and dynamic due date calculation.
 */
router.post('/generate-structure-invoice', authenticateToken, authorize(['admin', 'super admin']), async (req, res) => {
    const adminId = req.user.id;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        // 1. Fetch Students linked with Fee Structure (Now fetching s.admission_date)
        const studentsRes = await client.query(`
            SELECT 
                s.student_id, 
                u.username, 
                s.admission_date, /* ✅ ADDED: Fetch Admission Date */
                fs.id AS fee_structure_id,
                fs.structure_name,
                COALESCE(fs.tuition_fee, 0) AS tuition_monthly,
                COALESCE(fs.admission_fee, 0) AS admission,
                COALESCE(fs.registration_fee, 0) AS registration,
                COALESCE(fs.examination_fee, 0) AS exam,
                COALESCE(fs.course_duration_months, 12) AS duration, 
                COALESCE(fs.transport_fee, 0) AS transport_struct_monthly,
                COALESCE(fs.hostel_fee, 0) AS hostel_struct_monthly
            FROM ${DB.STUDENTS} s
            JOIN ${DB.USERS} u ON s.user_id = u.id
            JOIN ${DB.FEE_STRUCT} fs ON s.course_id = fs.course_id AND s.batch_id = fs.batch_id
            WHERE u.is_active = TRUE;
        `);

        let generatedCount = 0;
        let skippedCount = 0;

        for (const student of studentsRes.rows) {
            
            // Skip if admission date is missing
            if (!student.admission_date) {
                console.warn(`Skipping bulk invoice for ${student.username}: Admission date missing.`);
                skippedCount++;
                continue;
            }

            // Calculate dates dynamically
            const { issueDate, dueDate } = calculateDates(student.admission_date, student.duration);

            // 2. DUPLICATE CHECK
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
            const duration = student.duration;

            const addItem = (desc, amount) => {
                const amt = parseFloat(amount);
                if (amt > 0) {
                    items.push({ description: desc, amount: amt });
                    totalAmount += amt;
                }
            };
            
            // One-time fees
            addItem('Admission Fee', student.admission);
            addItem('Registration Fee', student.registration);
            addItem('Examination Fee', student.exam);

            // Transport Fee is INCLUDED
            if (student.transport_struct_monthly > 0) {
                addItem(`Transport Fee (${duration} Months)`, student.transport_struct_monthly * duration);
            }
            
            // Hostel Fee is INCLUDED
            if (student.hostel_struct_monthly > 0) {
                addItem(`Hostel Fee (${duration} Months)`, student.hostel_struct_monthly * duration);
            }

            if (totalAmount === 0) continue; 

            // 4. Insert Invoice Header (Uses dynamically calculated dates)
            const invRes = await client.query(`
                INSERT INTO ${DB.INVOICES} 
                (student_id, invoice_number, issue_date, due_date, total_amount, status, created_by, fee_structure_id)
                VALUES ($1::uuid, $2, $3::date, $4::date, $5, 'Pending', $6::uuid, $7::uuid) 
                RETURNING id;
            `, [
                student.student_id, 
                generateInvoiceNumber(), 
                issueDate, 
                dueDate, 
                totalAmount, 
                adminId,
                student.fee_structure_id 
            ]);
            
            const invoiceId = invRes.rows[0].id;
            
            // 5. Insert Line Items
            if (items.length > 0) {
                const itemsValues = items.map(item => `('${invoiceId}', '${item.description.replace(/'/g, "''")}', ${item.amount})`).join(',');
                await client.query(`INSERT INTO ${DB.ITEMS} (invoice_id, description, amount) VALUES ${itemsValues};`);
            }
            
            generatedCount++;
        }

        await client.query('COMMIT');
        res.status(201).json({ message: `Structure Generation Complete. Generated: ${generatedCount}, Skipped (Already Assigned): ${skippedCount}` });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error("Invoice Generation Error:", error);
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
        // Refund is recorded as a negative invoice/credit note
        await pool.query(`INSERT INTO ${DB.INVOICES} (student_id, invoice_number, total_amount, paid_amount, status, created_by) VALUES ($1::uuid, $2, $3, $3, 'Refunded', $4::uuid)`, [student_id, creditNote, -amount, req.user.id]);
        res.status(200).json({ message: "Refund processed.", credit_note: creditNote });
    } catch (e) { res.status(500).json({ message: "Refund failed." }); }
});


/**
 * 2.4 LIST STUDENTS ELIGIBLE FOR REFUND (FINAL FIX - Schema Aligned)
 */
router.get('/list-for-refund', authenticateToken, authorize(['admin', 'finance']), async (req, res) => {
    try {
        const query = `
            SELECT DISTINCT 
                s.student_id, 
                u.username AS student_name, 
                s.roll_number,
                c.course_name
            FROM ${DB.PAYMENTS} p
            JOIN ${DB.STUDENTS} s ON p.student_id = s.student_id
            JOIN ${DB.USERS} u ON s.user_id = u.id
            LEFT JOIN ${DB.COURSES} c ON s.course_id = c.id 
            ORDER BY u.username ASC
        `;
        
        const result = await pool.query(query);
        res.json(result.rows);

    } catch (error) {
        console.error("Refund List Error:", error);
        res.status(500).json({ message: 'Failed to fetch student list for refund.' });
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
 * 3.2 SMART STUDENT DASHBOARD (Auto-Generate/Summary)
 * FIX: Tuition Fee calculation removed; Transport/Hostel mandatory fallback added.
 * FIX: Uses student's admission_date as issue_date and dynamic due date calculation.
 */
router.get('/student/:studentId', authenticateToken, authorize(FEE_ROLES), async (req, res) => {
    const client = await pool.connect();
    try {
        const { studentId } = req.params;
        const adminId = req.user.id; 

        await client.query('BEGIN');

        // 1. Fetch Student, Structure, Duration AND Assignments (Added s.admission_date)
        const sRes = await client.query(`
            SELECT 
                s.student_id, 
                u.username, 
                s.roll_number,
                s.admission_date, /* ✅ ADDED: Fetch Admission Date */
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
                COALESCE(fs.transport_fee, 0) AS transport_struct_monthly, 
                COALESCE(fs.hostel_fee, 0) AS hostel_struct_monthly,     

                -- Transport Info
                ta.monthly_fee AS transport_assigned_fee,
                r.monthly_fee AS route_base_fee,
                r.route_name,
                ta.is_active AS transport_active,

                -- Hostel Info
                hr.room_fee AS hostel_monthly_rate,
                hr.rate_name AS hostel_room_name

            FROM ${DB.STUDENTS} s 
            JOIN ${DB.USERS} u ON s.user_id=u.id 
            LEFT JOIN ${DB.COURSES} c ON s.course_id=c.id 
            LEFT JOIN ${DB.BATCHES} b ON s.batch_id = b.id
            
            -- Link Fee Structure
            LEFT JOIN ${DB.FEE_STRUCT} fs ON s.course_id = fs.course_id AND s.batch_id = fs.batch_id
            
            -- Link Transport 
            LEFT JOIN student_transport_assignments ta ON s.student_id = ta.student_id AND ta.is_active = TRUE
            LEFT JOIN ${DB.ROUTES} r ON ta.route_id = r.id

            -- Link Hostel
            LEFT JOIN student_hostel_assignments ha ON s.student_id = ha.student_id
            LEFT JOIN ${DB.HOSTEL} hr ON ha.hostel_rate_id = hr.id

            WHERE s.student_id=$1::uuid
        `, [studentId]);

        if (!sRes.rows[0]) {
            await client.query('ROLLBACK');
            return res.status(404).json({message: 'Student not found'});
        }
        
        const student = sRes.rows[0];

        // Ensure admission date exists before proceeding (Fixes initialization error if date is missing)
        if (!student.admission_date) {
            // Commit to avoid full rollback, but send back empty stats if core data is missing.
            await client.query('COMMIT'); 
            return res.json({ 
                student_name: student.username, roll_number: student.roll_number,
                total_fees: 0, total_paid: 0, balance: 0, payments: [] 
            });
        }
        
        // Calculate dates dynamically
        const { issueDate, dueDate } = calculateDates(student.admission_date, student.duration);

        // 2. CHECK & AUTO-GENERATE INVOICE LOGIC
        if (student.fee_structure_id) {
            
            const invCheck = await client.query(`
                SELECT id FROM ${DB.INVOICES} 
                WHERE student_id = $1::uuid AND fee_structure_id = $2::uuid
            `, [student.student_id, student.fee_structure_id]);

            if (invCheck.rowCount === 0) {
                console.log(`Auto-generating invoice for ${student.username}...`);
                
                const duration = parseInt(student.duration);

                // ❌ A. Base Course Fees - Set to 0 as Tuition is removed
                const totalTuition = 0; 
                
                // B. Transport Calculation (Priority: Assigned Active > Structure Mandatory)
                let totalTransport = 0;
                let transportMonthly = 0;
                
                if (student.transport_active) {
                    transportMonthly = parseFloat(student.transport_assigned_fee) > 0 
                        ? parseFloat(student.transport_assigned_fee) 
                        : parseFloat(student.route_base_fee || 0);
                    totalTransport = transportMonthly * duration;
                } 
                // CRITICAL FIX: Fallback to Structure Fee if Assignment is NOT Active but fee is MANDATORY
                else if (parseFloat(student.transport_struct_monthly) > 0) { 
                    transportMonthly = parseFloat(student.transport_struct_monthly);
                    totalTransport = transportMonthly * duration;
                }

                // C. Hostel Calculation (Priority: Assigned Rate > Structure Mandatory)
                let totalHostel = 0;
                let hostelMonthly = 0;
                
                if (student.hostel_monthly_rate) { // Use Assigned Rate
                    hostelMonthly = parseFloat(student.hostel_monthly_rate);
                } 
                // CRITICAL FIX: Fallback to Structure Rate if Assignment is NOT found but fee is MANDATORY
                else if (parseFloat(student.hostel_struct_monthly) > 0) { 
                    hostelMonthly = parseFloat(student.hostel_struct_monthly);
                }

                if (hostelMonthly > 0) {
                    totalHostel = hostelMonthly * duration;
                }

                // Grand Total
                let totalAmount = 
                    totalTuition + // totalTuition is 0
                    totalTransport +
                    totalHostel +
                    parseFloat(student.admission) + 
                    parseFloat(student.registration) + 
                    parseFloat(student.exam);

                if (totalAmount > 0) {
                    // Create Header (Uses dynamically calculated dates)
                    const invRes = await client.query(`
                        INSERT INTO ${DB.INVOICES} 
                        (student_id, invoice_number, issue_date, due_date, total_amount, status, created_by, fee_structure_id)
                        VALUES ($1::uuid, $2, $3::date, $4::date, $5, 'Pending', $6::uuid, $7::uuid) 
                        RETURNING id;
                    `, [student.student_id, generateInvoiceNumber(), issueDate, dueDate, totalAmount, adminId, student.fee_structure_id]);
                    
                    const newInvId = invRes.rows[0].id;

                    // Create Items List
                    const items = [
                        { d: 'Admission Fee', a: student.admission },
                        { d: 'Registration Fee', a: student.registration },
                        { d: 'Examination Fee', a: student.exam }
                    ];

                    if (totalTransport > 0) {
                        items.push({ 
                            d: `Transport Fee (${student.route_name || 'Mandatory'} - ${duration} Months)`, 
                            a: totalTransport 
                        });
                    }

                    if (totalHostel > 0) {
                        items.push({ 
                            d: `Hostel Fee (${student.hostel_room_name || 'Mandatory'} - ${duration} Months)`, 
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
        const currencySymbol = config.currency === 'INR' ? '₹' : (config.currency || 'Rs.');

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
        await client.query('ROLLBACK');
        console.error("Receipt Error:", e);
        res.status(500).json({ message: 'PDF Gen Failed' }); 
    } finally {
        client.release();
    }
});


// =========================================================
// SECTION 4: SETTINGS & CONFIGURATION (ADMIN CRUD)
// =========================================================

// 4.1 DISCOUNT MANAGEMENT (CRUD)
router.get('/discounts', authenticateToken, async (req, res) => {
    try { const r = await pool.query(`SELECT * FROM ${DB.DISCOUNTS} ORDER BY created_at DESC`); res.json(r.rows); } catch (e) { res.status(500).json({message:'Error'}); }
});
router.post('/discounts', authenticateToken, authorize(['admin']), async (req, res) => {
    try { const r = await pool.query(`INSERT INTO ${DB.DISCOUNTS} (name, type, value, description) VALUES ($1, $2, $3, $4) RETURNING *`, [req.body.name, req.body.type, req.body.value, req.body.description]); res.status(201).json(r.rows[0]); } catch (e) { res.status(500).json({message:'Error'}); }
});
router.delete('/discounts/:id', authenticateToken, authorize(['admin']), async (req, res) => {
    try { await pool.query(`DELETE FROM ${DB.DISCOUNTS} WHERE id=$1::uuid`, [req.params.id]); res.json({message:'Deleted'}); } catch (e) { res.status(500).json({message:'Error'}); }
});

// 4.2 HOSTEL RATES (CRUD)
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
        // Ensures only one configuration exists
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

// 4.4 BUDGET TARGET CONFIG (Omitted for brevity)
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

// 5.1 GLOBAL TRANSACTION HISTORY (Omitted for brevity)
router.get('/history', authenticateToken, authorize(['admin', 'super admin', 'finance']), async (req, res) => {
    const { startDate, endDate } = req.query;
    const start = startDate || moment().startOf('month').format('YYYY-MM-DD');
    const end = endDate || moment().endOf('month').format('YYYY-MM-DD');

    try {
        const query = `
            SELECT 
                p.id AS payment_id,  
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

// 5.2 REVENUE STREAM (Omitted for brevity)
router.get('/reports/revenue-stream', authenticateToken, authorize(['admin', 'finance']), async (req, res) => {
    const { start_date, end_date } = req.query;
    const s = start_date || moment().startOf('month').format('YYYY-MM-DD');
    const e = end_date || moment().endOf('month').format('YYYY-MM-DD');
    try {
        // Groups income by invoice item description (e.g., 'Admission Fee', 'Transport Fee')
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
        // 1. Fetch Configured Targets (omitted for brevity)
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

        // 2. Calculate & Merge Actual Income (omitted for brevity)
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

        // 3. Calculate & Merge Actual Expenses (omitted for brevity)
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

// 5.4 EXPENSE RECORDING (Omitted for brevity)
router.post('/expenses', authenticateToken, authorize(['admin', 'finance']), async (req, res) => {
    const { category_name, amount, description, date } = req.body;
    try {
        const cat = await pool.query(`SELECT id FROM ${DB.BUDGET_CATS} WHERE name=$1`, [category_name]);
        if (!cat.rows[0]) return res.status(404).json({message: "Category not found"});
        await pool.query(`INSERT INTO ${DB.EXPENSES} (category_id, amount, expense_date, description, recorded_by) VALUES ($1, $2, $3, $4, $5)`, [cat.rows[0].id, amount, date||new Date(), description, req.user.id]);
        res.status(201).json({message: "Recorded"});
    } catch (e) { res.status(500).json({ message: e.message }); }
});

// 5.5 REVENUE FORECAST (Omitted for brevity)
router.get('/reports/revenue-forecast', authenticateToken, async (req, res) => {
    try {
        // Forecasts revenue based on outstanding balances of invoices due in the next 6 months
        const q = `SELECT TO_CHAR(due_date, 'Mon YYYY') as month, SUM(total_amount - paid_amount) as projected FROM ${DB.INVOICES} WHERE status IN ('Pending', 'Partial') AND due_date BETWEEN CURRENT_DATE AND (CURRENT_DATE + INTERVAL '6 months') GROUP BY month ORDER BY month`;
        const r = await pool.query(q);
        res.json(r.rows);
    } catch (e) { res.status(500).json({message: 'Error'}); }
});


// 5.6 DASHBOARD QUICK STATS (Omitted for brevity)
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
        
        // Fetch Student Basic Info for Header (omitted for brevity)
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

// 5.8 DETAILED STUDENT DUES REPORT
router.get('/reports/student-dues', authenticateToken, authorize(['admin', 'finance', 'super admin']), async (req, res) => {
    const { course_id, search } = req.query;

    try {
        let query = `
            SELECT 
                s.student_id, /* ✅ FIX: Added student_id for frontend navigation */
                s.roll_number, 
                u.username AS student_name, 
                c.course_name,
                COALESCE(SUM(i.total_amount), 0) AS total_billed,
                COALESCE(SUM(i.paid_amount), 0) AS total_paid,
                (COALESCE(SUM(i.total_amount), 0) - COALESCE(SUM(i.paid_amount), 0)) AS balance_due,
                MAX(p.payment_date) AS last_payment_date
            FROM ${DB.STUDENTS} s
            JOIN ${DB.USERS} u ON s.user_id = u.id
            LEFT JOIN ${DB.COURSES} c ON s.course_id = c.id
            LEFT JOIN ${DB.INVOICES} i ON s.student_id = i.student_id AND i.status != 'Waived'
            LEFT JOIN ${DB.PAYMENTS} p ON i.id = p.invoice_id
            WHERE u.is_active = TRUE
        `;

        const params = [];
        let paramIndex = 1;

        if (course_id && course_id !== 'all') {
            query += ` AND s.course_id = $${paramIndex++}::uuid`;
            params.push(course_id);
        }

        if (search) {
            query += ` AND (LOWER(u.username) LIKE $${paramIndex} OR LOWER(s.roll_number) LIKE $${paramIndex})`;
            params.push(`%${search.toLowerCase()}%`);
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
        res.status(500).json({ message: 'Failed to generate dues report.' });
    }
});


// 5.9 GENERAL LEDGER EXPORT (FIXED CAFETERIA COLUMNS BASED ON SCHEMA)
router.get('/reports/gl-export', authenticateToken, authorize(['admin', 'finance', 'super admin']), async (req, res) => {
    const { startDate, endDate } = req.query;
    const start = startDate || moment().startOf('year').format('YYYY-MM-DD');
    const end = endDate || moment().endOf('year').format('YYYY-MM-DD');

    try {
        const query = `
            SELECT * FROM (
                -- 1. FEE INCOME (Credit)
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
                
                -- 2. OPERATIONAL EXPENSES (Debit)
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
                
                UNION ALL
                
                -- 3. PAYROLL EXPENSE (Debit)
                -- Uses confirmed payroll columns from schema analysis: ps.pay_date and ps.net_pay
                SELECT
                    ps.pay_date AS date,
                    'Expense' AS type,
                    'Payroll' AS category,
                    (COALESCE(t.full_name, 'Staff') || ' Salary Payout, ID: ' || ps.employee_id) AS description,
                    0.00 AS credit,
                    ps.net_pay AS debit
                FROM pay_slips ps
                LEFT JOIN teachers t ON ps.teacher_id = t.id
                WHERE ps.pay_date::date >= $1 AND ps.pay_date::date <= $2
                
                UNION ALL
                
                -- 4. CAFETERIA INCOME (Credit)
                -- FIX: Using confirmed schema columns: ct.created_at and ct.amount
                SELECT 
                    ct.created_at::date AS date,
                    'Income' AS type,
                    'Cafeteria Sales' AS category,
                    ('Cafeteria Sale Ref: ' || ct.id::text) AS description,
                    ct.amount AS credit,
                    0.00 AS debit
                FROM cafeteria_transactions ct
                WHERE ct.type = 'Sale' /* Use 'type' column for filtering */
                  AND ct.created_at::date >= $1 AND ct.created_at::date <= $2

            ) ledger_data
            ORDER BY date DESC
        `;

        const result = await pool.query(query, [start, end]);
        res.status(200).json(result.rows);

    } catch (error) {
        console.error('GL Export Error:', error);
        res.status(500).json({ message: 'Failed to generate GL report. SQL Error likely.' });
    }
});





// =========================================================
// SECTION 6: ADMIN UTILITIES (WAIVERS, DEFAULTERS)
// =========================================================

// 6.1 WAIVER REQUESTS (CRUD)
router.get('/waiver-requests', authenticateToken, authorize(FEE_ROLES), async (req, res) => {
    try { const r = await pool.query(`SELECT * FROM ${DB.WAIVERS} ORDER BY request_date DESC`); res.json(r.rows); } catch (e) { res.status(500).json({message:'Error'}); }
});

router.put('/waiver-requests/:requestId/status', authenticateToken, authorize(['admin', 'super admin']), async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { requestId } = req.params; const { newStatus, amount } = req.body;
        await client.query(`UPDATE ${DB.WAIVERS} SET status=$1, processed_by=$2::uuid WHERE id=$3::uuid`, [newStatus, req.user.id, requestId]);
        
        // If approved, update the invoice total amount to reflect the waiver/discount
        if (newStatus === 'Approved' && amount > 0) {
            const wRes = await client.query(`SELECT student_id FROM ${DB.WAIVERS} WHERE id=$1::uuid`, [requestId]);
            const inv = await client.query(`SELECT id FROM ${DB.INVOICES} WHERE student_id=$1::uuid AND status!='Paid' LIMIT 1`, [wRes.rows[0].student_id]);
            if (inv.rows[0]) await client.query(`UPDATE ${DB.INVOICES} SET total_amount=total_amount-$1, discount_amount=COALESCE(discount_amount,0)+$1 WHERE id=$2::uuid`, [amount, inv.rows[0].id]);
        }
        await client.query('COMMIT'); res.json({message: `Waiver ${newStatus}`});
    } catch (e) { await client.query('ROLLBACK'); res.status(500).json({message: e.message}); } finally { client.release(); }
});

// 6.2 DEFAULTERS LIST
router.get('/defaulters', authenticateToken, authorize(['admin', 'finance']), async (req, res) => {
    try {
        const query = `
            SELECT 
                s.student_id, 
                u.username AS student_name,      
                s.roll_number, 
                COALESCE(u.phone_number, 'N/A') AS parent_phone, 
                c.course_name, 
                b.batch_name,                    
                COUNT(i.id) AS pending_invoices_count, 
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


// 6.3 FINANCE AUDIT LOGS
router.get('/audit-logs', authenticateToken, authorize(['admin', 'super admin', 'finance']), async (req, res) => {
    const { startDate, endDate } = req.query;
    const start = startDate || moment().startOf('month').format('YYYY-MM-DD');
    const end = endDate || moment().endOf('month').format('YYYY-MM-DD');

    try {
        const query = `
            SELECT * FROM (
                -- 1. PAYMENT ACTIONS
                SELECT 
                    p.payment_date AS timestamp,
                    'PAYMENT_COLLECTED' AS action_type,
                    u.username AS performed_by,
                    (
                        'Collected ₹' || COALESCE(p.amount::text, '0') || 
                        ' from ' || COALESCE(s.first_name, 'Student') || ' ' || COALESCE(s.last_name, '') ||
                        ' (Roll: ' || COALESCE(s.roll_number, 'N/A') || ')' ||
                        ' via ' || COALESCE(p.payment_mode, 'Unknown')
                    ) AS details,
                    p.transaction_id AS reference_id
                FROM ${DB.PAYMENTS} p
                JOIN ${DB.USERS} u ON p.collected_by = u.id
                JOIN ${DB.INVOICES} i ON p.invoice_id = i.id
                JOIN ${DB.STUDENTS} s ON i.student_id = s.student_id
                WHERE p.payment_date::date >= $1 AND p.payment_date::date <= $2

                UNION ALL

                -- 2. INVOICE ACTIONS
                SELECT 
                    i.created_at AS timestamp,
                    'INVOICE_GENERATED' AS action_type,
                    u.username AS performed_by,
                    (
                        'Generated Bill of ₹' || COALESCE(i.total_amount::text, '0') || 
                        ' for ' || COALESCE(s.first_name, 'Student') || ' ' || COALESCE(s.last_name, '') ||
                        ' (Roll: ' || COALESCE(s.roll_number, 'N/A') || ')'
                    ) AS details,
                    i.invoice_number AS reference_id
                FROM ${DB.INVOICES} i
                JOIN ${DB.USERS} u ON i.created_by = u.id
                JOIN ${DB.STUDENTS} s ON i.student_id = s.student_id
                WHERE i.created_at::date >= $1 AND i.created_at::date <= $2
            ) audit_data
            ORDER BY timestamp DESC
        `;

        const result = await pool.query(query, [start, end]);
        res.status(200).json(result.rows);

    } catch (error) {
        console.error('Audit Log Error:', error);
        res.status(500).json({ message: 'Failed to fetch audit logs.' });
    }
});

function toUUID(value) {
    if (!value || typeof value !== 'string' || value.trim() === '') return null;
    return value.trim();
}

// routes/fees.js (Excerpt focusing on the fixed receipt route)

// ... (Other imports and constants)

// --- Helper: Safely Convert String to UUID or Null ---
function toUUID(value) {
    if (!value || typeof value !== 'string' || value.trim() === '') return null;
    return value.trim();
}

// ... (Other sections 1 and 2 remain the same) ...

// =========================================================
// SECTION 3: STUDENT DATA & RECEIPTS
// =========================================================

// ... (Routes 3.1 and 3.2 remain the same) ...


/**
 * 3.3 GET STUDENT RECEIPTS LIST (Final Fix Applied)
 * @route   GET /api/fees/student/:studentId/receipts
 * @desc    Get a list of successfully completed payments (receipts) for a student.
 * @access  Private (Student Self-View, Admin)
 */
router.get('/student/:studentId/receipts', authenticateToken, authorize(['Student', 'Admin', 'Accountant']), async (req, res) => {
    const studentId = req.params.studentId;
    const safeStudentId = toUUID(studentId);

    if (!safeStudentId) {
        return res.status(400).json({ message: 'Invalid Student ID.' });
    }

    try {
        const query = `
            SELECT
                p.id AS receipt_id, 
                p.payment_date,
                p.amount,
                p.payment_mode,
                p.transaction_id,
                
                -- ✅ FIX 1: COALESCE handles missing p.receipt_number
                COALESCE(p.transaction_id, p.id::text) AS receipt_number, 
                
                i.invoice_number,
                -- ✅ FIX 2: Replaced non-existent i.description with i.invoice_number
                i.invoice_number AS description,
                i.status 
            FROM ${DB.PAYMENTS} p
            JOIN ${DB.INVOICES} i ON p.invoice_id = i.id
            -- Ensure i.student_id (UUID) is correctly compared with $1::uuid
            WHERE i.student_id = $1::uuid AND i.status != 'Waived'
            ORDER BY p.payment_date DESC;
        `;
        
        const result = await pool.query(query, [safeStudentId]); 
        res.status(200).json(result.rows);

    } catch (error) {
        console.error('Error fetching student receipts (Final Check):', error);
        res.status(500).json({ 
            message: 'Failed to retrieve fee receipt history. Database integrity check required.', 
            error: error.message 
        });
    }
});

// ... (Rest of the file remains the same) ...

module.exports = router;