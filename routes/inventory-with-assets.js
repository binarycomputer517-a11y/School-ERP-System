// routes/erp-routes.js (Combined Asset and Inventory Logic)

const express = require('express');
const router = express.Router();
// NOTE: Assuming pool import is correctly destructured elsewhere: const { pool } = require('../database'); 
const { pool } = require('../database'); 
const { authenticateToken, authorize } = require('../authMiddleware'); 
const moment = require('moment'); // Required if you use date formatting/manipulation

// =========================================================
// DATABASE TABLE CONSTANTS 
// =========================================================
const ITEMS_TABLE = 'inventory_items'; 
const VENDORS_TABLE = 'inventory_vendors';
const MOVEMENT_TABLE = 'inventory_movement'; 
const PO_TABLE = 'purchase_orders'; 
const USERS_TABLE = 'users'; 

// FIX: Changing from 'school_assets' to a safer, likely name 'fixed_assets'. 
// Please ensure this matches your actual asset table name (e.g., 'assets').
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

// Helper function placeholder for file uploads (must be defined in server.js)
const executeUpload = (req, res, fieldName, successCallback) => {
    // Logic from previous context is assumed to be implemented here
    res.status(500).json({ message: "Upload service not implemented in this mock." });
};


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
        const initialStatus = (low_stock_threshold > 0) ? 'Out of Stock' : 'In Stock';

        const query = `
            INSERT INTO ${ITEMS_TABLE} (name, category, unit_cost, low_stock_threshold, location_id, vendor_id, current_stock, status)
            VALUES ($1, $2, $3, $4, $5, $6, 0, $7)
            RETURNING id;
        `;
        const result = await client.query(query, [
            name, category, unit_cost, low_stock_threshold, location_id, vendor_id || null, initialStatus
        ]);
        
        await client.query('COMMIT');
        res.status(201).json({ message: 'Item created successfully. Stock is 0.', item_id: result.rows[0].id });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error adding inventory item:', error);
        res.status(500).json({ message: 'Failed to add item.' });
    } finally {
        client.release();
    }
});

router.get('/inventory/items', authenticateToken, async (req, res) => {
    try {
        const query = `
            SELECT 
                i.*, 
                v.name AS vendor_name
            FROM ${ITEMS_TABLE} i
            LEFT JOIN ${VENDORS_TABLE} v ON i.vendor_id = v.id
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

    try {
        const query = `
            UPDATE ${ITEMS_TABLE}
            SET name = $1, category = $2, unit_cost = $3, low_stock_threshold = $4, location_id = $5, vendor_id = $6
            WHERE id = $7
            RETURNING id;
        `;
        const result = await pool.query(query, [
            name, category, unit_cost, low_stock_threshold, location_id, vendor_id || null, id
        ]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Item not found.' });
        }
        res.status(200).json({ message: 'Item updated successfully.' });
    } catch (error) {
        console.error('Error updating inventory item:', error);
        res.status(500).json({ message: 'Failed to update item.' });
    }
});

router.delete('/inventory/items/:id', authenticateToken, authorize(ADMIN_ROLES), async (req, res) => {
    const { id } = req.params;
    try {
        // NOTE: In a real system, you might want a soft delete (status change) instead of CASCADE DELETE.
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
    
    // Use req.user.id for consistency
    const recordedById = req.user.id; 
    
    const { item_id, movement_type, quantity, reference_id, recipient_id, notes } = req.body;
    
    if (!item_id || !movement_type || !quantity || quantity <= 0 || !MOVEMENT_TYPES.includes(movement_type)) {
        return res.status(400).json({ message: 'Missing or invalid movement details.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Determine new stock quantity and check for insufficient stock (OUT movements)
        // FOR UPDATE locks the row to prevent race conditions during concurrent stock updates
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
        
        // 2. Record Movement
        const moveQuery = `
            INSERT INTO ${MOVEMENT_TABLE} (item_id, movement_type, quantity_changed, current_stock_after, recorded_by_id, reference_id, recipient_id, notes)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING id;
        `;
        await client.query(moveQuery, [item_id, movement_type, stockChange, newStock, recordedById, reference_id || null, recipient_id || null, notes]);

        // 3. Update Item Stock and Status
        let newStatus = 'In Stock';
        if (newStock === 0) {
            newStatus = 'Out of Stock';
        } else if (newStock <= threshold) {
            newStatus = 'Low Stock';
        }

        const updateQuery = `
            UPDATE ${ITEMS_TABLE} SET current_stock = $1, status = $2 
            WHERE id = $3;
        `;
        await client.query(updateQuery, [newStock, newStatus, item_id]);

        await client.query('COMMIT');
        res.status(200).json({ message: `Stock movement recorded. New stock: ${newStock}. Status: ${newStatus}.`, new_stock: newStock });

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
            LEFT JOIN ${USERS_TABLE} u ON m.recorded_by_id = u.id
            WHERE m.item_id = $1
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

/**
 * @route   POST /api/inventory/vendors
 * @desc    Add a new inventory vendor.
 * @access  Private (Admin, Staff, Super Admin)
 */
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
        if (error.code === '23505') { // Unique violation (Vendor name already exists)
            return res.status(409).json({ message: 'Vendor name already exists.' });
        }
        console.error('Error creating vendor:', error);
        res.status(500).json({ message: 'Failed to create vendor.' });
    }
});


router.post('/inventory/purchase-order', authenticateToken, authorize(INVENTORY_MANAGEMENT_ROLES), async (req, res) => {
    
    // FIX: Use req.user.id for consistency
    const creatorId = req.user.id; 

    // CRITICAL CHECK: Ensure the ID is present before proceeding to the database insertion.
    if (!creatorId) {
        console.error("Security/Token Error: JWT token payload is missing userId.");
        return res.status(403).json({ message: 'Token context missing. Please re-authenticate.' }); 
    }
    
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

        // Store ordered items as JSON (or use a separate po_items table in production)
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

/**
 * @route   GET /api/inventory/purchase-order/history
 * @desc    Get a list of all created Purchase Orders.
 * @access  Private (Admin, Staff, Super Admin)
 */
router.get('/inventory/purchase-order/history', authenticateToken, authorize(INVENTORY_MANAGEMENT_ROLES), async (req, res) => {
    try {
        const query = `
            SELECT 
                po.id, po.status, po.total_cost, po.expected_delivery_date, po.created_at,
                po.ordered_items_json,  /* <-- FIX: This column is critical for PDF generation */
                v.name AS vendor_name,
                u.username AS created_by_name
            FROM ${PO_TABLE} po
            JOIN ${VENDORS_TABLE} v ON po.vendor_id = v.id
            JOIN ${USERS_TABLE} u ON po.created_by_id = u.id
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
// 4. NEW FEATURE: Stock Level Prediction
// =========================================================

/**
 * @route   GET /api/inventory/analytics/stock-prediction
 * @desc    Calculates predicted stock depletion date and suggested PO quantity for all items.
 * @access  Private (Admin, Super Admin)
 */
router.get('/inventory/analytics/stock-prediction', authenticateToken, authorize(ADMIN_ROLES), async (req, res) => {
    // NOTE: This implementation is a simplified mock.
    try {
        const query = `
            WITH UsageRate AS (
                SELECT 
                    item_id,
                    -- Calculate average daily usage (sum of OUT movements over the last 90 days)
                    SUM(CASE WHEN movement_type LIKE 'OUT%' THEN quantity_changed ELSE 0 END) / 90.0 AS daily_usage
                FROM ${MOVEMENT_TABLE}
                WHERE created_at >= NOW() - INTERVAL '90 days'
                GROUP BY item_id
            )
            
            SELECT
                i.id AS item_id,
                i.name,
                i.current_stock,
                i.low_stock_threshold,
                COALESCE(ur.daily_usage, 0) AS daily_usage,
                
                -- Calculate days remaining until stock hits threshold
                CASE
                    WHEN COALESCE(ur.daily_usage, 0) > 0 
                        THEN ROUND((i.current_stock - i.low_stock_threshold) / ur.daily_usage)
                    ELSE NULL
                END AS days_to_threshold,

                -- Suggested order: Order enough to reach 30 days of predicted stock + buffer
                CASE
                    WHEN i.current_stock <= i.low_stock_threshold AND COALESCE(ur.daily_usage, 0) > 0
                        THEN CEIL(ur.daily_usage * 30 - i.current_stock)
                    ELSE 0
                END AS suggested_po_qty
            FROM ${ITEMS_TABLE} i
            LEFT JOIN UsageRate ur ON i.id = ur.item_id
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

    try {
        const query = `
            INSERT INTO ${ASSETS_TABLE} (
                tag_number, name, category, purchase_date, purchase_cost, 
                depreciation_method, useful_life_years, current_location_id, status
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'Active')
            RETURNING id;
        `;
        const result = await pool.query(query, [
            tag_number, name, category, purchase_date, purchase_cost, 
            depreciation_method || 'Straight-Line', useful_life_years || 5, current_location_id
        ]);
        
        res.status(201).json({ message: 'Asset registered successfully.', asset_id: result.rows[0].id });
    } catch (error) {
        if (error.code === '23505') { 
            return res.status(409).json({ message: 'Asset Tag Number already exists.' });
        }
        console.error('Error registering asset:', error);
        res.status(500).json({ message: 'Failed to register asset.' });
    }
});

// View route available to Staff/Coordinators/Admins
router.get('/asset/all', authenticateToken, authorize(ASSET_VIEW_ROLES), async (req, res) => {
    try {
        const query = `
            SELECT 
                a.*,
                l.location_name,
                u.username AS assigned_user_name,
                u.role AS assigned_user_role,
                -- NEW FEATURE: Calculate current depreciation (Straight-Line Method)
                ROUND(a.purchase_cost * (
                    (EXTRACT(epoch FROM (NOW() - a.purchase_date)) / 31536000) / a.useful_life_years
                ), 2) AS accumulated_depreciation,
                (a.purchase_cost - ROUND(a.purchase_cost * (
                    (EXTRACT(epoch FROM (NOW() - a.purchase_date)) / 31536000) / a.useful_life_years
                ), 2)) AS current_book_value
            FROM ${ASSETS_TABLE} a
            LEFT JOIN ${LOCATIONS_TABLE} l ON a.current_location_id = l.id
            LEFT JOIN ${ASSIGNMENT_TABLE} assign ON a.id = assign.asset_id AND assign.is_active = TRUE
            LEFT JOIN ${USERS_TABLE} u ON assign.user_id = u.id
            ORDER BY a.status, a.tag_number;
        `;
        const result = await pool.query(query);
        res.status(200).json(result.rows);
    } catch (error) {
        // This log is crucial for debugging the 500 error in the frontend.
        console.error('Error fetching assets:', error); 
        res.status(500).json({ message: 'Failed to retrieve assets.' });
    }
});

// ASSIGNMENT & DEPLOYMENT
router.post('/asset/assign', authenticateToken, authorize(['Admin', 'Staff']), async (req, res) => {
    const { asset_id, user_id, assigned_location_id, notes } = req.body;
    
    // Use req.user.id for consistency
    const assigned_by_id = req.user.id;
    
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // Deactivate any current assignment
        await client.query(`UPDATE ${ASSIGNMENT_TABLE} SET is_active = FALSE, returned_at = CURRENT_TIMESTAMP WHERE asset_id = $1 AND is_active = TRUE`, [asset_id]);

        // Create new assignment log entry
        const assignQuery = `
            INSERT INTO ${ASSIGNMENT_TABLE} (asset_id, user_id, location_id, assigned_by_id, notes, is_active)
            VALUES ($1, $2, $3, $4, $5, TRUE)
            RETURNING id;
        `;
        const result = await client.query(assignQuery, [asset_id, user_id, assigned_location_id, assigned_by_id, notes || null]);

        // Update asset's current location/status
        await client.query(`UPDATE ${ASSETS_TABLE} SET current_location_id = $1, status = 'Active' WHERE id = $2`, [assigned_location_id, asset_id]);

        await client.query('COMMIT');
        res.status(201).json({ message: 'Asset assigned successfully.', assignment_id: result.rows[0].id });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Asset Assignment Error:', error);
        res.status(500).json({ message: 'Failed to assign asset.' });
    } finally {
        client.release();
    }
});

// MAINTENANCE & REPAIR LOG
router.post('/asset/maintenance', authenticateToken, authorize(['Admin', 'Staff']), async (req, res) => {
    const { asset_id, type, details, maintenance_cost, vendor, scheduled_date, completion_date } = req.body;
    
    // Use req.user.id for consistency
    const requested_by_id = req.user.id;
    
    if (!asset_id || !type || !details) {
        return res.status(400).json({ message: 'Missing required maintenance details.' });
    }
    if (!MAINTENANCE_TYPES.includes(type)) {
        return res.status(400).json({ message: 'Invalid maintenance type.' });
    }
    
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
        
        // Update asset status if a repair is initiated and not yet complete
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
                m.*,
                u.username AS requester_name
            FROM ${MAINTENANCE_TABLE} m
            LEFT JOIN ${USERS_TABLE} u ON m.requested_by_id = u.id
            WHERE m.asset_id = $1
            ORDER BY m.scheduled_date DESC;
        `;
        const result = await pool.query(query, [assetId]);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching maintenance log:', error);
        res.status(500).json({ message: 'Failed to retrieve maintenance log.' });
    }
});

// LOCATION MANAGEMENT (CRUD)
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