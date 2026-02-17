const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const QRCode = require('qrcode');
const nodemailer = require('nodemailer');

// ===========================================
// SECTION A: INVENTORY ITEMS & ADVANCED STOCK
// ===========================================

// 1. Get Live Inventory with Predictive Analytics
router.get('/items', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT *, 
            CASE 
                WHEN quantity_in_stock <= 0 THEN 'CRITICAL_OUT'
                WHEN quantity_in_stock <= min_stock_level THEN 'LOW_REORDER'
                ELSE 'HEALTHY'
            END as stock_health,
            (unit_price * quantity_in_stock) as asset_valuation
            FROM inventory_items 
            ORDER BY created_at DESC
        `);
        res.json(result.rows);
    } catch (err) {
        console.error("Master SKU Fetch Failure:", err);
        res.status(500).json({ error: "Inventory Service Unavailable" });
    }
});

// 2. Register New Product with Automated QR Label Data
router.post('/add-item', async (req, res) => {
    const { item_name, item_type, min_stock_level, unit_price, location_aisle, location_bin } = req.body;
    
    try {
        const sku_code = `SKU-${Date.now().toString().slice(-8)}`;
        const qr_data = JSON.stringify({ sku: sku_code, name: item_name, loc: `${location_aisle}-${location_bin}` });
        const qr_image_blob = await QRCode.toDataURL(qr_data);

        const newItem = await pool.query(
            `INSERT INTO inventory_items 
            (item_name, item_type, sku_code, min_stock_level, unit_price, location_aisle, location_bin, qr_code_data)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
            [item_name, item_type, sku_code, min_stock_level || 5, unit_price || 0, location_aisle, location_bin, qr_image_blob]
        );
        res.json({ success: true, data: newItem.rows[0] });
    } catch (err) {
        console.error("SKU Injection Failure:", err);
        res.status(500).json({ error: "Database rejected new SKU record" });
    }
});

// 3. Delete SKU with Historical Integrity Protection
router.delete('/:id', async (req, res) => {
    try {
        const historyCheck = await pool.query('SELECT 1 FROM purchase_order_items WHERE item_id = $1 LIMIT 1', [req.params.id]);
        if (historyCheck.rows.length > 0) {
            return res.status(403).json({ error: "System Lock: Cannot delete item with active procurement history." });
        }
        await pool.query('DELETE FROM inventory_items WHERE id = $1', [req.params.id]);
        res.json({ success: true, message: "SKU purged from master record" });
    } catch (err) {
        res.status(500).json({ error: "System deletion authority denied" });
    }
});

// ===========================================
// SECTION B: SUPPLY CHAIN & PARTNER RELATIONS
// ===========================================

router.get('/vendors', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM inventory_suppliers ORDER BY company_name ASC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: "Supplier registry offline" });
    }
});

router.post('/vendors', async (req, res) => {
    const { company_name, contact_person, phone, email, address, gst_number } = req.body;
    try {
        await pool.query(
            `INSERT INTO inventory_suppliers (company_name, contact_person, phone, email, address, gst_number)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [company_name, contact_person, phone, email, address, gst_number]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: "Partner onboarding failed" });
    }
});

// ===========================================
// SECTION C: TRANSACTIONAL PROCUREMENT ENGINE
// ===========================================

// 1. Get All POs (Aligned with your DB Column names)
router.get('/purchase-orders', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT po.*, s.company_name as vendor_name, s.email as vendor_email
            FROM purchase_orders po
            LEFT JOIN inventory_suppliers s ON po.supplier_id = s.id
            ORDER BY po.created_at DESC
        `);
        res.json(result.rows);
    } catch (err) {
        console.error("PO List Error:", err);
        res.status(500).json({ error: "Failed to fetch procurement records" });
    }
});

// 2. Get Specific PO Details (Supports Tally Grid PDF)
router.get('/purchase-orders/:id', async (req, res) => {
    try {
        const poRes = await pool.query(`
            SELECT po.*, s.company_name as vendor_name, s.email as vendor_email, 
                   s.address as vendor_address, s.gst_number
            FROM purchase_orders po
            JOIN inventory_suppliers s ON po.supplier_id = s.id
            WHERE po.id = $1`, [req.params.id]);

        const itemsRes = await pool.query(`
            SELECT poi.*, i.item_name 
            FROM purchase_order_items poi
            JOIN inventory_items i ON poi.item_id = i.id
            WHERE poi.po_id = $1`, [req.params.id]);

        if (poRes.rows.length === 0) return res.status(404).json({ error: "Voucher not found" });
        res.json({ ...poRes.rows[0], items: itemsRes.rows });
    } catch (err) {
        res.status(500).json({ error: "Error fetching voucher details" });
    }
});

// 3. Generate Multi-Item PO (Database Transaction)

router.post('/purchase-orders', async (req, res) => {
    const { supplier_id, expected_date, items } = req.body;
    if (!items || items.length === 0) return res.status(400).json({ error: "Empty order manifest." });

    const client = await pool.connect();
    try {
        await client.query('BEGIN'); 

        const poNumber = `VOUCH-${new Date().getFullYear()}${Date.now().toString().slice(-4)}`;
        const net_total = items.reduce((sum, i) => sum + (i.quantity * i.unit_cost), 0);

        const poRes = await client.query(
            `INSERT INTO purchase_orders (po_number, supplier_id, expected_date, total_amount, status, order_date)
             VALUES ($1, $2, $3, $4, 'Pending', CURRENT_DATE) RETURNING id`,
            [poNumber, supplier_id, expected_date, net_total]
        );
        const poId = poRes.rows[0].id;

        for (const item of items) {
            await client.query(
                `INSERT INTO purchase_order_items (po_id, item_id, quantity_ordered, unit_cost)
                 VALUES ($1, $2, $3, $4)`,
                [poId, item.item_id, item.quantity, item.unit_cost]
            );
        }

        await client.query('COMMIT'); 
        res.json({ success: true, po_number: poNumber });
    } catch (err) {
        await client.query('ROLLBACK'); 
        console.error("Procurement Engine Fault:", err);
        res.status(500).json({ error: "Transaction aborted." });
    } finally {
        client.release();
    }
});

// 4. Automated Commercial Relay (Email System - FIXED 400 ERROR)

router.post('/send-po-email', async (req, res) => {
    const { supplier_email, po_number, pdf_base64 } = req.body;

    if (!supplier_email || !pdf_base64 || !po_number) {
        return res.status(400).json({ success: false, error: "Missing Parameters" });
    }

    try {
        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
        });

        const cleanPDFData = pdf_base64.includes("base64,") ? pdf_base64.split("base64,")[1] : pdf_base64;

        const mailOptions = {
            from: `"Procurement Unit" <${process.env.EMAIL_USER}>`,
            to: supplier_email,
            subject: `Official Order Issued: ${po_number}`,
            text: `Greetings. Please find the attached Purchase Voucher ${po_number}.`,
            attachments: [{
                filename: `${po_number}.pdf`,
                content: cleanPDFData,
                encoding: 'base64'
            }]
        };

        await transporter.sendMail(mailOptions);
        res.json({ success: true, message: "Relay dispatched successfully" });
    } catch (error) {
        console.error("SMTP Relay Failure:", error);
        res.status(500).json({ error: "Global mail relay offline" });
    }
});

// 5. Warehouse Intake (Stock Re-sync)
router.post('/purchase-orders/:id/receive', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const poInfo = await client.query('SELECT status FROM purchase_orders WHERE id = $1', [req.params.id]);
        
        if (!poInfo.rows[0] || poInfo.rows[0].status === 'Received') {
            throw new Error("Voucher already reconciled.");
        }

        const items = await client.query('SELECT item_id, quantity_ordered FROM purchase_order_items WHERE po_id = $1', [req.params.id]);
        
        for (const lineItem of items.rows) {
            await client.query(
                'UPDATE inventory_items SET quantity_in_stock = quantity_in_stock + $1 WHERE id = $2', 
                [lineItem.quantity_ordered, lineItem.item_id]
            );
        }

        await client.query("UPDATE purchase_orders SET status = 'Received' WHERE id = $1", [req.params.id]);
        await client.query('COMMIT');
        res.json({ success: true, message: "Inventory re-synchronized." });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

module.exports = router;