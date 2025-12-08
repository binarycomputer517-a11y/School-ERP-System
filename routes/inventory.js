// routes/inventory.js

const express = require('express');
const router = express.Router();
const { pool } = require('../database'); 
const { authenticateToken, authorize } = require('../authMiddleware'); 
// Assuming these are available in your utils folder.
const { toUUID, resolveLocationId } = require('../utils/helpers'); 
const moment = require('moment'); 

// === Dependency Constants ===
const ITEMS_TABLE = 'inventory_items'; 
const VENDORS_TABLE = 'inventory_vendors';
const MOVEMENT_TABLE = 'inventory_movement'; 
const PO_TABLE = 'purchase_orders'; 
const USERS_TABLE = 'users'; 
const LOCATIONS_TABLE = 'asset_locations'; // Used for item location lookup

const MOVEMENT_TYPES = ['IN_PURCHASE', 'IN_RETURN', 'OUT_ISSUE', 'OUT_DISPOSAL'];
const INVENTORY_MANAGEMENT_ROLES = ['Admin', 'Super Admin', 'Staff']; 
const ADMIN_ROLES = ['Admin', 'Super Admin']; 
// === END Constants ===


// =========================================================
// A. INVENTORY ROUTES (Internal Paths)
// =========================================================

// ITEM MANAGEMENT (CRUD)
router.post('/items', authenticateToken, authorize(INVENTORY_MANAGEMENT_ROLES), async (req, res) => {
    const { name, category, unit_cost, low_stock_threshold, location_id, vendor_id } = req.body;
    
    if (!name || !category || !unit_cost || !low_stock_threshold) {
        return res.status(400).json({ message: 'Missing required item details.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        // NOTE: The resolveLocationId implementation must accept (client, inputId, LOCATIONS_TABLE)
        // Adjusting the call here based on the assumed structure from your initial files:
        const finalLocationId = location_id ? await resolveLocationId(client, location_id) : null;

        const initialStatus = (low_stock_threshold > 0) ? 'Out of Stock' : 'In Stock';

        const query = `
            INSERT INTO ${ITEMS_TABLE} (name, category, unit_cost, low_stock_threshold, location_id, vendor_id, current_stock, status)
            VALUES ($1, $2, $3, $4, $5, $6, 0, $7)
            RETURNING id;
        `;
        const result = await client.query(query, [
            name, category, unit_cost, low_stock_threshold, finalLocationId, vendor_id || null, initialStatus
        ]);
        
        await client.query('COMMIT');
        res.status(201).json({ message: 'Item created successfully. Stock is 0.', item_id: result.rows[0].id });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error adding inventory item:', error);
        res.status(500).json({ message: 'Failed to add item: ' + error.message });
    } finally {
        client.release();
    }
});

router.get('/items', authenticateToken, async (req, res) => {
    try {
        const query = `
            SELECT 
                i.*, 
                v.name AS vendor_name,
                l.location_name
            FROM ${ITEMS_TABLE} i
            LEFT JOIN ${VENDORS_TABLE} v ON i.vendor_id::text = v.id::text
            LEFT JOIN ${LOCATIONS_TABLE} l ON i.location_id::text = l.id::text
            ORDER BY i.status, i.name;
        `;
        const result = await pool.query(query);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching inventory items:', error);
        res.status(500).json({ message: 'Failed to retrieve inventory items.' });
    }
});

router.put('/items/:id', authenticateToken, authorize(INVENTORY_MANAGEMENT_ROLES), async (req, res) => {
    const { id } = req.params;
    const { name, category, unit_cost, low_stock_threshold, location_id, vendor_id } = req.body;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const finalLocationId = location_id ? await resolveLocationId(client, location_id) : null;

        const query = `
            UPDATE ${ITEMS_TABLE}
            SET name = $1, category = $2, unit_cost = $3, low_stock_threshold = $4, location_id = $5, vendor_id = $6
            WHERE id = $7
            RETURNING id;
        `;
        const result = await client.query(query, [
            name, category, unit_cost, low_stock_threshold, finalLocationId, vendor_id || null, id
        ]);
        
        if (result.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Item not found.' });
        }
        
        await client.query('COMMIT');
        res.status(200).json({ message: 'Item updated successfully.' });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error updating inventory item:', error);
        res.status(500).json({ message: 'Failed to update item: ' + error.message });
    } finally {
        client.release();
    }
});

router.delete('/items/:id', authenticateToken, authorize(ADMIN_ROLES), async (req, res) => {
    const { id } = req.params;
    try {
        const result = await pool.query(`DELETE FROM ${ITEMS_TABLE} WHERE id = $1 RETURNING id`, [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Item not found.' });
        }
        res.status(200).json({ message: 'Item deleted successfully.' });
    } catch (error) {
        console.error('Error deleting item:', error);
        res.status(500).json({ message: 'Failed to delete item.' });
    }
});

// STOCK MOVEMENT (IN/OUT)
router.post('/move', authenticateToken, authorize(INVENTORY_MANAGEMENT_ROLES), async (req, res) => {
    const recordedById = req.user.id; 
    const { item_id, movement_type, quantity, reference_id, recipient_id, notes } = req.body;
    
    if (!item_id || !movement_type || !quantity || quantity <= 0 || !MOVEMENT_TYPES.includes(movement_type)) {
        return res.status(400).json({ message: 'Missing or invalid movement details.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Lock the row for update to prevent race conditions
        const currentRes = await client.query(`SELECT current_stock, low_stock_threshold FROM ${ITEMS_TABLE} WHERE id = $1 FOR UPDATE`, [item_id]);
        if (currentRes.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Item not found.' });
        }

        let currentStock = parseInt(currentRes.rows[0].current_stock, 10);
        const threshold = parseInt(currentRes.rows[0].low_stock_threshold, 10);
        let newStock;

        const isOut = movement_type.startsWith('OUT');
        const stockChange = isOut ? -quantity : quantity;
        newStock = currentStock + stockChange;

        if (isOut && newStock < 0) {
            await client.query('ROLLBACK');
            return res.status(409).json({ message: `Insufficient stock. Available: ${currentStock}. Cannot fulfill request for ${quantity}.` });
        }
        
        // 1. Record the movement
        const moveQuery = `
            INSERT INTO ${MOVEMENT_TABLE} (item_id, movement_type, quantity_changed, current_stock_after, recorded_by_id, reference_id, recipient_id, notes)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING id;
        `;
        await client.query(moveQuery, [item_id, movement_type, stockChange, newStock, recordedById, reference_id || null, recipient_id || null, notes]);

        // 2. Update the item stock and status
        let newStatus = 'In Stock';
        if (newStock === 0) {
            newStatus = 'Out of Stock';
        } else if (newStock <= threshold) {
            newStatus = 'Low Stock';
        }

        await client.query(`UPDATE ${ITEMS_TABLE} SET current_stock = $1, status = $2 WHERE id = $3`, [newStock, newStatus, item_id]);

        await client.query('COMMIT');
        res.status(200).json({ message: `Stock movement recorded. New stock: ${newStock}.`, new_stock: newStock });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Stock Movement Error:', error);
        res.status(500).json({ message: 'Failed to record stock movement.' });
    } finally {
        client.release();
    }
});


router.get('/movement/:itemId', authenticateToken, async (req, res) => {
    const { itemId } = req.params;
    try {
        const query = `
            SELECT 
                m.quantity_changed, m.current_stock_after, m.movement_type, m.created_at, 
                m.notes, m.reference_id, m.recorded_by_id,
                u.username AS recorded_by_name
            FROM ${MOVEMENT_TABLE} m
            LEFT JOIN ${USERS_TABLE} u ON m.recorded_by_id::text = u.id::text
            WHERE m.item_id::text = $1::text
            ORDER BY m.created_at DESC;
        `;
        const result = await pool.query(query, [itemId]);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching movement history:', error);
        res.status(500).json({ message: 'Failed to retrieve movement history.' });
    }
});

// VENDOR & ORDER MANAGEMENT
router.get('/vendors', authenticateToken, authorize(INVENTORY_MANAGEMENT_ROLES), async (req, res) => {
    try {
        const query = `SELECT * FROM ${VENDORS_TABLE} ORDER BY name;`;
        const result = await pool.query(query);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching vendors:', error);
        res.status(500).json({ message: 'Failed to retrieve vendors.' });
    }
});

router.post('/vendors', authenticateToken, authorize(INVENTORY_MANAGEMENT_ROLES), async (req, res) => {
    const { name, contact_person, phone, email } = req.body;
    
    if (!name || !contact_person) {
        return res.status(400).json({ message: 'Vendor name and contact person are required.' });
    }

    try {
        const query = `
            INSERT INTO ${VENDORS_TABLE} (name, contact_person, phone, email)
            VALUES ($1, $2, $3, $4)
            RETURNING id, name;
        `;
        const result = await pool.query(query, [name, contact_person, phone || null, email || null]);
        
        res.status(201).json({ message: `Vendor ${name} created successfully.`, vendor: result.rows[0] });
    } catch (error) {
        if (error.code === '23505') { 
            return res.status(409).json({ message: 'Vendor name already exists.' });
        }
        console.error('Error creating vendor:', error);
        res.status(500).json({ message: 'Failed to create vendor.' });
    }
});


router.post('/purchase-order', authenticateToken, authorize(INVENTORY_MANAGEMENT_ROLES), async (req, res) => {
    const creatorId = req.user.id; 
    if (!creatorId) return res.status(403).json({ message: 'Token context missing.' }); 
    
    const { vendor_id, items_ordered, expected_delivery_date, total_cost } = req.body; 

    // 🛑 CRITICAL FIX: Ensure expected_delivery_date is checked as it is NOT NULL in DB
    if (!vendor_id || !items_ordered || items_ordered.length === 0 || !total_cost || !expected_delivery_date) {
        return res.status(400).json({ message: 'Missing required PO details: Vendor, Items, Cost, or Expected Delivery Date.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const poQuery = `
            INSERT INTO ${PO_TABLE} (vendor_id, created_by_id, expected_delivery_date, total_cost, status)
            VALUES ($1, $2, $3::date, $4, 'Pending')
            RETURNING id;
        `;
        const poResult = await client.query(poQuery, [
            vendor_id, creatorId, expected_delivery_date, total_cost
        ]);
        const poId = poResult.rows[0].id;

        // items_ordered must be serialized as JSON (assuming it's an array of objects)
        await client.query(`UPDATE ${PO_TABLE} SET ordered_items_json = $1 WHERE id = $2`, [JSON.stringify(items_ordered), poId]);
        
        await client.query('COMMIT');
        res.status(201).json({ message: 'Purchase Order created and submitted.', po_id: poId });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('PO Creation Error:', error);
        res.status(500).json({ message: 'Failed to create Purchase Order.' });
    } finally {
        client.release();
    }
});

router.get('/purchase-order/history', authenticateToken, authorize(INVENTORY_MANAGEMENT_ROLES), async (req, res) => {
    try {
        const query = `
            SELECT 
                po.id, po.status, po.total_cost, po.expected_delivery_date, po.created_at,
                po.ordered_items_json,
                v.name AS vendor_name,
                u.username AS created_by_name
            FROM ${PO_TABLE} po
            JOIN ${VENDORS_TABLE} v ON po.vendor_id::text = v.id::text
            JOIN ${USERS_TABLE} u ON po.created_by_id::text = u.id::text
            ORDER BY po.created_at DESC;
        `;
        const result = await pool.query(query);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching PO history:', error);
        res.status(500).json({ message: 'Failed to retrieve Purchase Order history.' });
    }
});

// =========================================================
// STOCK PREDICTION
// =========================================================
router.get('/analytics/stock-prediction', authenticateToken, authorize(ADMIN_ROLES), async (req, res) => {
    try {
        const query = `
            WITH UsageRate AS (
                SELECT 
                    item_id,
                    SUM(CASE WHEN movement_type LIKE 'OUT%' THEN quantity_changed ELSE 0 END) / 90.0 AS daily_usage
                FROM ${MOVEMENT_TABLE}
                WHERE created_at >= NOW() - INTERVAL '90 days'
                GROUP BY item_id
            )
            SELECT
                i.id AS item_id, i.name, i.current_stock, i.low_stock_threshold,
                COALESCE(ur.daily_usage, 0) AS daily_usage,
                CASE
                    WHEN COALESCE(ur.daily_usage, 0) > 0 
                        THEN ROUND((i.current_stock - i.low_stock_threshold) / ur.daily_usage)
                    ELSE NULL
                END AS days_to_threshold,
                CASE
                    WHEN i.current_stock <= i.low_stock_threshold AND COALESCE(ur.daily_usage, 0) > 0
                        THEN CEIL(ur.daily_usage * 30 - i.current_stock)
                    ELSE 0
                END AS suggested_po_qty
            FROM ${ITEMS_TABLE} i
            LEFT JOIN UsageRate ur ON i.id::text = ur.item_id::text
            WHERE i.status != 'Discontinued'
            ORDER BY days_to_threshold ASC NULLS LAST;
        `;
        const result = await pool.query(query);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching stock prediction:', error);
        res.status(500).json({ message: 'Failed to run stock prediction analysis.' });
    }
});

module.exports = router;