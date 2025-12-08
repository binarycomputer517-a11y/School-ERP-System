// routes/asset.js

const express = require('express');
const router = express.Router();
const { pool } = require('../database'); 
const { authenticateToken, authorize } = require('../authMiddleware'); 
// Assuming these are available in your utils folder.
const { toUUID, resolveLocationId } = require('../utils/helpers'); 

// === Dependency Constants ===
const USERS_TABLE = 'users'; 
const ASSETS_TABLE = 'fixed_assets'; 
const MAINTENANCE_TABLE = 'asset_maintenance_log';
const ASSIGNMENT_TABLE = 'asset_assignments';
const LOCATIONS_TABLE = 'asset_locations'; 

const MAINTENANCE_TYPES = ['Scheduled', 'Repair', 'Calibration', 'Upgrade'];
const ASSET_VIEW_ROLES = ['Admin', 'Super Admin', 'Staff', 'Coordinator']; 
// === END Constants ===

// =========================================================
// B. ASSET ROUTES (Internal Paths)
// =========================================================

// ASSET MANAGEMENT (CRUD)
/**
 * @route POST /api/asset/register
 * @desc Registers a new fixed asset.
 */
router.post('/register', authenticateToken, authorize(['Admin', 'Staff']), async (req, res) => {
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

        // Resolve location name to ID if needed
        const finalLocationId = current_location_id ? await resolveLocationId(client, current_location_id) : null;

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

/**
 * @route GET /api/asset/all
 * @desc Retrieves the main asset list with depreciation and assignment info.
 */
router.get('/all', authenticateToken, authorize(ASSET_VIEW_ROLES), async (req, res) => {
    try {
        // Query calculates current depreciation and book value (straight-line method)
        const query = `
            SELECT 
                a.*,
                l.location_name,
                u.username AS assigned_user_name,
                u.role AS assigned_user_role,
                -- Calculate accumulated depreciation (Purchase Cost * (Time Elapsed / Useful Life))
                ROUND(a.purchase_cost * (
                    (EXTRACT(epoch FROM (NOW() - a.purchase_date)) / 31536000) / a.useful_life_years
                ), 2) AS accumulated_depreciation,
                -- Calculate Current Book Value
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
/**
 * @route POST /api/asset/assign
 * @desc Assigns an asset to a user, closing any prior active assignments.
 */
router.post('/assign', authenticateToken, authorize(['Admin', 'Staff']), async (req, res) => {
    const { asset_id, user_id, assigned_location_id, notes } = req.body;
    const assigned_by_id = req.user.id;
    
    if (!asset_id || !user_id || !assigned_location_id) {
        return res.status(400).json({ message: 'Asset ID, User ID, and Location are required for assignment.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const finalLocationId = await resolveLocationId(client, assigned_location_id);

        // 1. Close any prior active assignment for this asset
        await client.query(`UPDATE ${ASSIGNMENT_TABLE} SET is_active = FALSE, returned_at = CURRENT_TIMESTAMP WHERE asset_id = $1 AND is_active = TRUE`, [asset_id]);

        // 2. Create the new assignment record
        const assignQuery = `
            INSERT INTO ${ASSIGNMENT_TABLE} (asset_id, user_id, location_id, assigned_by_id, notes, is_active)
            VALUES ($1, $2, $3, $4, $5, TRUE)
            RETURNING id;
        `;
        const result = await client.query(assignQuery, [asset_id, user_id, finalLocationId, assigned_by_id, notes || null]);

        // 3. Update the asset's current location and status
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
/**
 * @route POST /api/asset/maintenance
 * @desc Logs a maintenance event against an asset. Updates asset status if 'Repair'.
 */
router.post('/maintenance', authenticateToken, authorize(['Admin', 'Staff']), async (req, res) => {
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
        
        // If the maintenance is a Repair that hasn't finished, set asset status to 'In Repair'
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

/**
 * @route GET /api/asset/maintenance/log/:assetId
 * @desc Retrieves all maintenance history for a single asset.
 */
router.get('/maintenance/log/:assetId', authenticateToken, authorize(ASSET_VIEW_ROLES), async (req, res) => {
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
/**
 * @route GET /api/asset/locations
 * @desc Retrieves all known asset locations (for dropdowns/management).
 */
router.get('/locations', authenticateToken, authorize(ASSET_VIEW_ROLES), async (req, res) => {
    try {
        const query = `SELECT id, location_name FROM ${LOCATIONS_TABLE} ORDER BY location_name;`;
        const result = await pool.query(query);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching locations:', error);
        res.status(500).json({ message: 'Failed to retrieve locations.' });
    }
});

// HELPER ROUTE: Get User List for Dropdowns
/**
 * @route GET /api/asset/users-list
 * @desc Retrieves a list of users (staff/students) for asset assignment dropdowns.
 */
router.get('/users-list', authenticateToken, authorize(ASSET_VIEW_ROLES), async (req, res) => {
    try {
        // NOTE: The frontend expects 'id' and 'display_name'.
        const query = `
            SELECT 
                id, 
                username AS display_name, 
                role 
            FROM ${USERS_TABLE} 
            WHERE role != 'Parent' AND is_active = TRUE 
            ORDER BY username
        `;
        const result = await pool.query(query);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching user list:', error);
        res.status(500).json({ message: 'Failed to retrieve users.' });
    }
});

module.exports = router;