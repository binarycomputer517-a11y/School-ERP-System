const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const QRCode = require('qrcode'); // Ensure 'npm install qrcode' is run

// ===========================================
// SECTION A: INVENTORY ITEMS & STOCK
// ===========================================

// 1. Get All Items
router.get('/items', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT * FROM inventory_items 
            ORDER BY created_at DESC
        `);
        res.json(result.rows);
    } catch (err) {
        console.error("Fetch Items Error:", err);
        res.status(500).json({ error: "Server Error" });
    }
});

// 2. Add New Item (with QR Code)
router.post('/add-item', async (req, res) => {
    const { 
        item_name, item_type, min_stock_level, unit_price, 
        location_aisle, location_bin 
    } = req.body;

    try {
        // A. Generate Unique SKU
        const sku_code = `SKU-${Date.now().toString().slice(-6)}`;
        
        // B. Prepare QR Data
        const qrData = JSON.stringify({
            sku: sku_code,
            name: item_name,
            type: item_type
        });

        // C. Generate QR Image
        const qrCodeImage = await QRCode.toDataURL(qrData);

        // D. Insert into Database
        const newItem = await pool.query(
            `INSERT INTO inventory_items 
            (item_name, item_type, sku_code, qr_code_data, image_url, 
             min_stock_level, unit_price, location_aisle, location_bin)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             RETURNING *`,
            [
                item_name, item_type, sku_code, qrData, qrCodeImage, 
                min_stock_level || 10, unit_price || 0, 
                location_aisle, location_bin
            ]
        );

        res.json({ 
            success: true, 
            message: 'Item added successfully!',
            data: newItem.rows[0],
            qr_image: qrCodeImage
        });

    } catch (err) {
        console.error("Add Item Error:", err);
        res.status(500).json({ error: err.message });
    }
});

// 3. Update Stock (Manual Adjustment)
router.post('/update-stock', async (req, res) => {
    const { item_id, quantity, type, remarks } = req.body; 
    // type: 'ADD' or 'REMOVE'

    try {
        let adjustment = parseInt(quantity);
        if (type === 'REMOVE') adjustment = -adjustment;

        // Update Inventory Table
        const updateRes = await pool.query(
            `UPDATE inventory_items 
             SET quantity_in_stock = quantity_in_stock + $1 
             WHERE id = $2 RETURNING item_name, quantity_in_stock`,
            [adjustment, item_id]
        );

        if (updateRes.rows.length === 0) {
            return res.status(404).json({ error: "Item not found" });
        }

        // Optional: Log to 'inventory_transactions' table if you have one
        // await pool.query('INSERT INTO ...');

        res.json({ 
            success: true, 
            message: 'Stock updated',
            new_stock: updateRes.rows[0].quantity_in_stock
        });

    } catch (err) {
        console.error("Stock Update Error:", err);
        res.status(500).json({ error: "Server Error" });
    }
});

// 4. Delete Item
router.delete('/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM inventory_items WHERE id = $1', [req.params.id]);
        res.json({ success: true, message: 'Item deleted' });
    } catch (err) {
        console.error("Delete Error:", err);
        // Usually fails due to Foreign Key constraints (if item is in a PO)
        res.status(500).json({ error: 'Cannot delete item. It is linked to existing Purchase Orders.' });
    }
});

// 5. Low Stock Alerts
router.get('/alerts', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT item_name, quantity_in_stock, min_stock_level 
             FROM inventory_items 
             WHERE quantity_in_stock <= min_stock_level`
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: "Server Error" });
    }
});


// ===========================================
// SECTION B: VENDOR MANAGEMENT
// ===========================================

// 1. Get Vendors
router.get('/vendors', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM inventory_suppliers ORDER BY company_name ASC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2. Add Vendor
router.post('/vendors', async (req, res) => {
    const { company_name, contact_person, phone, email, address, gst_number } = req.body;
    try {
        await pool.query(
            `INSERT INTO inventory_suppliers (company_name, contact_person, phone, email, address, gst_number)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [company_name, contact_person, phone, email, address, gst_number]
        );
        res.json({ success: true, message: "Vendor added" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 3. Delete Vendor
router.delete('/vendors/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM inventory_suppliers WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Cannot delete vendor. They have linked Purchase Orders.' });
    }
});


// ===========================================
// SECTION C: PURCHASE ORDERS (Advanced)
// ===========================================

// 1. Get All POs (with Vendor Name)
router.get('/purchase-orders', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT po.id, po.po_number, po.order_date, po.expected_date, po.total_amount, po.status, po.created_at,
                   s.company_name as vendor_name 
            FROM purchase_orders po
            LEFT JOIN inventory_suppliers s ON po.supplier_id = s.id
            ORDER BY po.created_at DESC
        `);
        res.json(result.rows);
    } catch (err) {
        console.error("PO List Error:", err);
        res.status(500).json({ error: err.message });
    }
});

// 2. Create Purchase Order (Transaction)
router.post('/purchase-orders', async (req, res) => {
    const { supplier_id, order_date, expected_date, items } = req.body; 
    // items is an array: [{ item_id, quantity, unit_cost }, ...]

    const client = await pool.connect();
    try {
        await client.query('BEGIN'); // Start Transaction

        // A. Generate Custom PO Number (e.g. PO-2026-9921)
        const poNumber = `PO-${new Date().getFullYear()}-${Date.now().toString().slice(-4)}`;
        
        // B. Calculate Total Amount
        let totalAmount = 0;
        items.forEach(i => totalAmount += (i.quantity * i.unit_cost));

        // C. Insert Master PO
        const poRes = await client.query(
            `INSERT INTO purchase_orders 
            (po_number, supplier_id, created_at, expected_date, total_amount, status)
             VALUES ($1, $2, $3, $4, $5, 'Pending') 
             RETURNING id`,
            [poNumber, supplier_id, order_date || new Date(), expected_date, totalAmount]
        );
        const poId = poRes.rows[0].id;

        // D. Insert PO Items
        for (const item of items) {
            const lineTotal = item.quantity * item.unit_cost;
            await client.query(
                `INSERT INTO purchase_order_items 
                (po_id, item_id, quantity_ordered, unit_cost, total_cost)
                 VALUES ($1, $2, $3, $4, $5)`,
                [poId, item.item_id, item.quantity, item.unit_cost, lineTotal]
            );
        }

        await client.query('COMMIT'); // Commit Transaction
        res.json({ success: true, message: "Purchase Order Created", po_number: poNumber });

    } catch (err) {
        await client.query('ROLLBACK'); // Rollback on error
        console.error("PO Creation Error:", err);
        res.status(500).json({ error: "Failed to create Purchase Order" });
    } finally {
        client.release();
    }
});

// 3. Receive PO (Updates Inventory Stock)
router.post('/purchase-orders/:id/receive', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const poId = req.params.id;

        // A. Check if already received
        const statusCheck = await client.query("SELECT status FROM purchase_orders WHERE id = $1", [poId]);
        if(statusCheck.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: "PO not found" });
        }
        if(statusCheck.rows[0].status === 'Received') {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: "PO already received." });
        }

        // B. Get Items to Update Stock
        const itemsRes = await client.query('SELECT item_id, quantity_ordered FROM purchase_order_items WHERE po_id = $1', [poId]);
        
        // C. Update Inventory for each item
        for (const item of itemsRes.rows) {
            await client.query(
                `UPDATE inventory_items 
                 SET quantity_in_stock = quantity_in_stock + $1 
                 WHERE id = $2`,
                [item.quantity_ordered, item.item_id]
            );
        }

        // D. Mark PO as Received
        await client.query("UPDATE purchase_orders SET status = 'Received' WHERE id = $1", [poId]);

        await client.query('COMMIT');
        res.json({ success: true, message: "Stock Updated Successfully" });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error("PO Receive Error:", err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// 4. Delete PO (Only Pending allowed)
router.delete('/purchase-orders/:id', async (req, res) => {
    try {
        const check = await pool.query("SELECT status FROM purchase_orders WHERE id = $1", [req.params.id]);
        
        if (check.rows.length === 0) return res.status(404).json({ error: "PO not found" });
        
        if (check.rows[0].status !== 'Pending') {
            return res.status(400).json({ error: "Cannot delete a processed/received PO." });
        }

        await pool.query('DELETE FROM purchase_orders WHERE id = $1', [req.params.id]);
        res.json({ success: true, message: "PO Deleted" });
    } catch (err) {
        console.error("PO Delete Error:", err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;