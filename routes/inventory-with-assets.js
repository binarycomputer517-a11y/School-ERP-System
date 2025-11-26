const express = require('express');
const router = express.Router();
const { pool } = require('../database'); 
const { authenticateToken, authorize } = require('../authMiddleware'); 
const moment = require('moment'); 

// =========================================================
// DATABASE TABLE CONSTANTS 
// =========================================================
const ITEMS_TABLE = 'inventory_items'; 
const VENDORS_TABLE = 'inventory_vendors';
const MOVEMENT_TABLE = 'inventory_movement'; 
const PO_TABLE = 'purchase_orders'; 
const USERS_TABLE = 'users'; 

const ASSETS_TABLE = 'fixed_assets'; 
const MAINTENANCE_TABLE = 'asset_maintenance_log';
const ASSIGNMENT_TABLE = 'asset_assignments';
const LOCATIONS_TABLE = 'asset_locations'; 

// Constants
const MOVEMENT_TYPES = ['IN_PURCHASE', 'IN_RETURN', 'OUT_ISSUE', 'OUT_DISPOSAL'];
const MAINTENANCE_TYPES = ['Scheduled', 'Repair', 'Calibration', 'Upgrade'];
const INVENTORY_MANAGEMENT_ROLES = ['Admin', 'Super Admin', 'Staff']; 
const ADMIN_ROLES = ['Admin', 'Super Admin']; 
const ASSET_VIEW_ROLES = ['Admin', 'Super Admin', 'Staff', 'Coordinator']; 

// =========================================================
// HELPER FUNCTION: Resolve Location ID
// =========================================================
async function resolveLocationId(client, inputId) {
    if (!inputId) return null;

    // Regex to check if string is a valid UUID
    const isUUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(inputId);

    if (isUUID) {
        return inputId;
    } else {
        // It is a name (e.g., "ROOM -301"), look up the ID
        const res = await client.query(`SELECT id FROM ${LOCATIONS_TABLE} WHERE location_name = $1`, [inputId]);
        if (res.rows.length > 0) {
            return res.rows[0].id;
        } else {
            throw new Error(`Location '${inputId}' not found in database.`);
        }
    }
}

// =========================================================
// A. INVENTORY ROUTES (PREFIX: /api/inventory)
// =========================================================

// ITEM MANAGEMENT (CRUD)
router.post('/inventory/items', authenticateToken, authorize(INVENTORY_MANAGEMENT_ROLES), async (req, res) => {
    const { name, category, unit_cost, low_stock_threshold, location_id, vendor_id } = req.body;
    
    if (!name || !category || !unit_cost || !low_stock_threshold) {
        return res.status(400).json({ message: 'Missing required item details.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        const finalLocationId = await resolveLocationId(client, location_id);

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

router.get('/inventory/items', authenticateToken, async (req, res) => {
    try {
        // FIX APPLIED: explicitly casting IDs to text (::text) to avoid type mismatch errors
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

router.put('/inventory/items/:id', authenticateToken, authorize(INVENTORY_MANAGEMENT_ROLES), async (req, res) => {
    const { id } = req.params;
    const { name, category, unit_cost, low_stock_threshold, location_id, vendor_id } = req.body;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const finalLocationId = await resolveLocationId(client, location_id);

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

router.delete('/inventory/items/:id', authenticateToken, authorize(ADMIN_ROLES), async (req, res) => {
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
router.post('/inventory/move', authenticateToken, authorize(INVENTORY_MANAGEMENT_ROLES), async (req, res) => {
    const recordedById = req.user.id; 
    const { item_id, movement_type, quantity, reference_id, recipient_id, notes } = req.body;
    
    if (!item_id || !movement_type || !quantity || quantity <= 0 || !MOVEMENT_TYPES.includes(movement_type)) {
        return res.status(400).json({ message: 'Missing or invalid movement details.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

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
        
        const moveQuery = `
            INSERT INTO ${MOVEMENT_TABLE} (item_id, movement_type, quantity_changed, current_stock_after, recorded_by_id, reference_id, recipient_id, notes)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING id;
        `;
        await client.query(moveQuery, [item_id, movement_type, stockChange, newStock, recordedById, reference_id || null, recipient_id || null, notes]);

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


router.get('/inventory/movement/:itemId', authenticateToken, async (req, res) => {
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
router.get('/inventory/vendors', authenticateToken, authorize(INVENTORY_MANAGEMENT_ROLES), async (req, res) => {
    try {
        const query = `SELECT * FROM ${VENDORS_TABLE} ORDER BY name;`;
        const result = await pool.query(query);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching vendors:', error);
        res.status(500).json({ message: 'Failed to retrieve vendors.' });
    }
});

router.post('/inventory/vendors', authenticateToken, authorize(INVENTORY_MANAGEMENT_ROLES), async (req, res) => {
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


router.post('/inventory/purchase-order', authenticateToken, authorize(INVENTORY_MANAGEMENT_ROLES), async (req, res) => {
    const creatorId = req.user.id; 
    if (!creatorId) return res.status(403).json({ message: 'Token context missing.' }); 
    
    const { vendor_id, items_ordered, expected_delivery_date, total_cost } = req.body; 

    if (!vendor_id || !items_ordered || items_ordered.length === 0 || !total_cost) {
        return res.status(400).json({ message: 'Missing required PO details.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const poQuery = `
            INSERT INTO ${PO_TABLE} (vendor_id, created_by_id, expected_delivery_date, total_cost, status)
            VALUES ($1, $2, $3, $4, 'Pending')
            RETURNING id;
        `;
        const poResult = await client.query(poQuery, [
            vendor_id, creatorId, expected_delivery_date || null, total_cost
        ]);
        const poId = poResult.rows[0].id;

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

router.get('/inventory/purchase-order/history', authenticateToken, authorize(INVENTORY_MANAGEMENT_ROLES), async (req, res) => {
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
router.get('/inventory/analytics/stock-prediction', authenticateToken, authorize(ADMIN_ROLES), async (req, res) => {
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

// =========================================================
// B. ASSET ROUTES (PREFIX: /api/asset)
// =========================================================

// ASSET MANAGEMENT (CRUD)
router.post('/asset/register', authenticateToken, authorize(['Admin', 'Staff']), async (req, res) => {
    const { 
        tag_number, name, category, purchase_date, purchase_cost, 
        depreciation_method, useful_life_years, current_location_id 
    } = req.body;

    if (!tag_number || !name || !purchase_cost || !purchase_date) {
        return res.status(400).json({ message: 'Missing required asset details.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const finalLocationId = await resolveLocationId(client, current_location_id);

        const query = `
            INSERT INTO ${ASSETS_TABLE} (
                tag_number, name, category, purchase_date, purchase_cost, 
                depreciation_method, useful_life_years, current_location_id, status
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'Active')
            RETURNING id;
        `;
        const result = await client.query(query, [
            tag_number, name, category, purchase_date, purchase_cost, 
            depreciation_method || 'Straight-Line', useful_life_years || 5, finalLocationId
        ]);
        
        await client.query('COMMIT');
        res.status(201).json({ message: 'Asset registered successfully.', asset_id: result.rows[0].id });
    } catch (error) {
        await client.query('ROLLBACK');
        if (error.code === '23505') { 
            return res.status(409).json({ message: 'Asset Tag Number already exists.' });
        }
        console.error('Error registering asset:', error);
        res.status(500).json({ message: 'Failed to register asset: ' + error.message });
    } finally {
        client.release();
    }
});

router.get('/asset/all', authenticateToken, authorize(ASSET_VIEW_ROLES), async (req, res) => {
    try {
        // FIX APPLIED: explicitly casting IDs to text (::text) to avoid type mismatch errors
        const query = `
            SELECT 
                a.*,
                l.location_name,
                u.username AS assigned_user_name,
                u.role AS assigned_user_role,
                ROUND(a.purchase_cost * (
                    (EXTRACT(epoch FROM (NOW() - a.purchase_date)) / 31536000) / a.useful_life_years
                ), 2) AS accumulated_depreciation,
                (a.purchase_cost - ROUND(a.purchase_cost * (
                    (EXTRACT(epoch FROM (NOW() - a.purchase_date)) / 31536000) / a.useful_life_years
                ), 2)) AS current_book_value
            FROM ${ASSETS_TABLE} a
            LEFT JOIN ${LOCATIONS_TABLE} l ON a.current_location_id::text = l.id::text
            LEFT JOIN ${ASSIGNMENT_TABLE} assign ON a.id::text = assign.asset_id::text AND assign.is_active = TRUE
            LEFT JOIN ${USERS_TABLE} u ON assign.user_id::text = u.id::text
            ORDER BY a.status, a.tag_number;
        `;
        const result = await pool.query(query);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching assets:', error); 
        res.status(500).json({ message: 'Failed to retrieve assets.' });
    }
});

// ASSIGNMENT & DEPLOYMENT
router.post('/asset/assign', authenticateToken, authorize(['Admin', 'Staff']), async (req, res) => {
    const { asset_id, user_id, assigned_location_id, notes } = req.body;
    const assigned_by_id = req.user.id;
    
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const finalLocationId = await resolveLocationId(client, assigned_location_id);

        await client.query(`UPDATE ${ASSIGNMENT_TABLE} SET is_active = FALSE, returned_at = CURRENT_TIMESTAMP WHERE asset_id = $1 AND is_active = TRUE`, [asset_id]);

        const assignQuery = `
            INSERT INTO ${ASSIGNMENT_TABLE} (asset_id, user_id, location_id, assigned_by_id, notes, is_active)
            VALUES ($1, $2, $3, $4, $5, TRUE)
            RETURNING id;
        `;
        const result = await client.query(assignQuery, [asset_id, user_id, finalLocationId, assigned_by_id, notes || null]);

        await client.query(`UPDATE ${ASSETS_TABLE} SET current_location_id = $1, status = 'Active' WHERE id = $2`, [finalLocationId, asset_id]);

        await client.query('COMMIT');
        res.status(201).json({ message: 'Asset assigned successfully.', assignment_id: result.rows[0].id });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Asset Assignment Error:', error);
        res.status(500).json({ message: 'Failed to assign asset: ' + error.message });
    } finally {
        client.release();
    }
});

// MAINTENANCE & REPAIR LOG
router.post('/asset/maintenance', authenticateToken, authorize(['Admin', 'Staff']), async (req, res) => {
    const { asset_id, type, details, maintenance_cost, vendor, scheduled_date, completion_date } = req.body;
    const requested_by_id = req.user.id;
    
    if (!asset_id || !type || !details) return res.status(400).json({ message: 'Missing required maintenance details.' });
    if (!MAINTENANCE_TYPES.includes(type)) return res.status(400).json({ message: 'Invalid maintenance type.' });
    
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        const logQuery = `
            INSERT INTO ${MAINTENANCE_TABLE} (
                asset_id, maintenance_type, details, maintenance_cost, vendor, 
                scheduled_date, completion_date, requested_by_id
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING id;
        `;
        const result = await pool.query(logQuery, [
            asset_id, type, details, maintenance_cost || 0, vendor || null, 
            scheduled_date, completion_date || null, requested_by_id
        ]);
        
        if (type === 'Repair' && !completion_date) {
            await client.query(`UPDATE ${ASSETS_TABLE} SET status = 'In Repair' WHERE id = $1`, [asset_id]);
        }
        
        await client.query('COMMIT');
        res.status(201).json({ message: 'Maintenance logged successfully.', maintenance_id: result.rows[0].id });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Maintenance Log Error:', error);
        res.status(500).json({ message: 'Failed to log maintenance event.' });
    } finally {
        client.release();
    }
});

router.get('/asset/maintenance/log/:assetId', authenticateToken, async (req, res) => {
    const { assetId } = req.params;
    try {
        const query = `
            SELECT 
                m.*, u.username AS requester_name
            FROM ${MAINTENANCE_TABLE} m
            LEFT JOIN ${USERS_TABLE} u ON m.requested_by_id::text = u.id::text
            WHERE m.asset_id::text = $1::text
            ORDER BY m.scheduled_date DESC;
        `;
        const result = await pool.query(query, [assetId]);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching maintenance log:', error);
        res.status(500).json({ message: 'Failed to retrieve maintenance log.' });
    }
});

// LOCATION MANAGEMENT
router.get('/asset/locations', authenticateToken, async (req, res) => {
    try {
        const query = `SELECT * FROM ${LOCATIONS_TABLE} ORDER BY location_name;`;
        const result = await pool.query(query);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching locations:', error);
        res.status(500).json({ message: 'Failed to retrieve locations.' });
    }
});

module.exports = router;