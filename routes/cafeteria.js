// routes/cafeteria.js

const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken, authorize } = require('../authMiddleware');
const moment = require('moment');

// Database Table Constants
const ACCOUNTS_TABLE = 'cafeteria_accounts';
const TRANSACTIONS_TABLE = 'cafeteria_transactions';
const MENU_ITEMS_TABLE = 'cafeteria_menu_items';
const DAILY_MENU_TABLE = 'cafeteria_daily_menu';
const USERS_TABLE = 'users'; // Assumed to hold user IDs
const TEACHERS_TABLE = 'teachers'; // Holds staff details like full_name and department_id
const DEPARTMENTS_TABLE = 'hr_departments'; // Holds department details and role

// Shift Table Constants
const SHIFTS_TABLE = 'cafeteria_shifts';
const SHIFT_ASSIGNMENTS_TABLE = 'cafeteria_shift_assignments';

// Constants
const TRANSACTION_TYPES = ['PURCHASE', 'TOP_UP', 'REFUND'];

// =========================================================
// 1. ACCOUNT MANAGEMENT (TOP-UP & BALANCE)
// =========================================================

/**
 * @route   GET /api/cafeteria/balance/:userId
 * @desc    Get current prepaid balance for a user.
 * @access  Private (Self, Admin, Staff)
 */
router.get('/balance/:userId', authenticateToken, async (req, res) => {
    const { userId } = req.params;
    const requesterId = req.user.userId;
    const requesterRole = req.user.role;
    
    if (userId !== requesterId && requesterRole !== 'Admin' && requesterRole !== 'Staff') {
        return res.status(403).json({ message: 'Access denied.' });
    }

    try {
        const query = `
            SELECT 
                COALESCE(balance, 0.00) AS current_balance,
                last_updated
            FROM ${ACCOUNTS_TABLE}
            WHERE user_id = $1;
        `;
        const result = await pool.query(query, [userId]);
        
        if (result.rowCount === 0) {
            return res.status(200).json({ current_balance: 0.00, last_updated: null });
        }
        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Balance Fetch Error:', error);
        res.status(500).json({ message: 'Failed to retrieve account balance.' });
    }
});


/**
 * @route   POST /api/cafeteria/top-up
 * @desc    Process a manual account top-up.
 * @access  Private (Admin, Staff)
 */
router.post('/top-up', authenticateToken, authorize(['Admin', 'Staff']), async (req, res) => {
    const recordedById = req.user.userId;
    const { user_id, amount, payment_method } = req.body;
    
    if (!user_id || amount <= 0) {
        return res.status(400).json({ message: 'Missing user ID or invalid amount.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const accountQuery = `
            INSERT INTO ${ACCOUNTS_TABLE} (user_id, balance)
            VALUES ($1, $2)
            ON CONFLICT (user_id) DO UPDATE 
            SET balance = ${ACCOUNTS_TABLE}.balance + $2, last_updated = CURRENT_TIMESTAMP
            RETURNING balance;
        `;
        const accountRes = await client.query(accountQuery, [user_id, amount]);
        const newBalance = accountRes.rows[0].balance;

        const transactionQuery = `
            INSERT INTO ${TRANSACTIONS_TABLE} (user_id, type, amount, current_balance_after, recorded_by_id, notes)
            VALUES ($1, 'TOP_UP', $2, $3, $4, $5)
            RETURNING id;
        `;
        await client.query(transactionQuery, [user_id, amount, newBalance, recordedById, `Top-up via ${payment_method || 'Cash'}`]);

        await client.query('COMMIT');
        res.status(201).json({ message: 'Account topped up successfully.', new_balance: newBalance });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Top-up Error:', error);
        res.status(500).json({ message: 'Failed to process top-up.' });
    } finally {
        client.release();
    }
});

// =========================================================
// 2. ORDER PROCESSING
// =========================================================

/**
 * @route   POST /api/cafeteria/order
 * @desc    Process a new food order (deduct from balance).
 * @access  Private (Admin, Staff, or Student App processing)
 */
router.post('/order', authenticateToken, authorize(['Admin', 'Staff', 'Student']), async (req, res) => {
    const orderUserId = req.user.role === 'Student' ? req.user.userId : req.body.user_id; 
    const recordedById = req.user.userId;
    const { order_items, total_cost } = req.body;

    if (!orderUserId || total_cost <= 0) {
        return res.status(400).json({ message: 'Missing user ID or invalid cost.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Fetch current balance with lock
        const currentRes = await client.query(`SELECT balance FROM ${ACCOUNTS_TABLE} WHERE user_id = $1 FOR UPDATE`, [orderUserId]);
        
        // FIX: Explicitly parse balance as a float to prevent toFixed() TypeError
        let currentBalance = parseFloat(currentRes.rows[0]?.balance) || 0.00; 
        
        if (currentBalance < total_cost) {
            await client.query('ROLLBACK');
            return res.status(409).json({ message: `Insufficient balance. Available: ${currentBalance.toFixed(2)}. Needed: ${total_cost.toFixed(2)}.` });
        }

        const newBalance = currentBalance - total_cost;
        
        // 2. Update Account Balance
        await client.query(`
            UPDATE ${ACCOUNTS_TABLE} SET balance = $1, last_updated = CURRENT_TIMESTAMP
            WHERE user_id = $2;
        `, [newBalance, orderUserId]);

        // 3. Record Transaction
        const transactionQuery = `
            INSERT INTO ${TRANSACTIONS_TABLE} (user_id, type, amount, current_balance_after, recorded_by_id, order_details_json)
            VALUES ($1, 'PURCHASE', $2, $3, $4, $5)
            RETURNING id;
        `;
        await client.query(transactionQuery, [orderUserId, total_cost, newBalance, recordedById, JSON.stringify(order_items)]);

        await client.query('COMMIT');
        res.status(201).json({ message: 'Order processed successfully.', new_balance: newBalance });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Order Processing Error:', error);
        res.status(500).json({ message: 'Failed to process order.' });
    } finally {
        client.release();
    }
});

// =========================================================
// 3. MENU MANAGEMENT (Permanent Items & Daily Menu)
// =========================================================

/**
 * @route   POST /api/cafeteria/menu/add-item
 * @desc    Add a new permanent food item (for building menus).
 * @access  Private (Admin, Staff)
 */
router.post('/menu/add-item', authenticateToken, authorize(['Admin', 'Staff']), async (req, res) => {
    const { name, price, category } = req.body;
    try {
        const query = `
            INSERT INTO ${MENU_ITEMS_TABLE} (name, price, category)
            VALUES ($1, $2, $3)
            RETURNING id;
        `;
        const result = await pool.query(query, [name, price, category]);
        res.status(201).json({ message: 'Menu item added.', id: result.rows[0].id });
    } catch (error) {
        console.error('Add Menu Item Error:', error);
        res.status(500).json({ message: 'Failed to add menu item.' });
    }
});

// --- Permanent Item Management Routes (must be before /menu/:date) ---

/**
 * @route   GET /api/cafeteria/menu/items
 * @desc    Get all permanent menu items.
 * @access  Private (Admin, Staff)
 */
router.get('/menu/items', authenticateToken, authorize(['Admin', 'Staff']), async (req, res) => {
    try {
        const query = `
            SELECT id, name, price, category, is_available, created_at
            FROM ${MENU_ITEMS_TABLE}
            ORDER BY name ASC;
        `;
        const result = await pool.query(query);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Fetch Menu Items Error:', error);
        res.status(500).json({ message: 'Failed to retrieve permanent menu items.' });
    }
});

/**
 * @route   PUT /api/cafeteria/menu/toggle-availability/:itemId
 * @desc    Toggle the is_available status of a permanent menu item.
 * @access  Private (Admin, Staff)
 */
router.put('/menu/toggle-availability/:itemId', authenticateToken, authorize(['Admin', 'Staff']), async (req, res) => {
    const { itemId } = req.params;
    try {
        const query = `
            UPDATE ${MENU_ITEMS_TABLE}
            SET is_available = NOT is_available 
            WHERE id = $1
            RETURNING id, is_available;
        `;
        const result = await pool.query(query, [itemId]);

        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Menu item not found.' });
        }

        const newStatus = result.rows[0].is_available;
        res.status(200).json({ message: `Item availability updated to ${newStatus}.`, is_available: newStatus });
    } catch (error) {
        console.error('Toggle Availability Error:', error);
        res.status(500).json({ message: 'Failed to update item availability.' });
    }
});

/**
 * @route   PUT /api/cafeteria/menu/edit-item/:itemId
 * @desc    Update details (name, price, category) of a permanent menu item.
 * @access  Private (Admin, Staff)
 */
router.put('/menu/edit-item/:itemId', authenticateToken, authorize(['Admin', 'Staff']), async (req, res) => {
    const { itemId } = req.params;
    const { name, price, category } = req.body;

    if (!name || price === undefined || price <= 0) {
        return res.status(400).json({ message: 'Item name and valid price are required.' });
    }

    try {
        const query = `
            UPDATE ${MENU_ITEMS_TABLE}
            SET name = $1, 
                price = $2, 
                category = $3
            WHERE id = $4
            RETURNING id, name, price, category;
        `;
        const result = await pool.query(query, [name, price, category || null, itemId]);

        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Menu item not found.' });
        }

        res.status(200).json({ 
            message: 'Menu item updated successfully.', 
            item: result.rows[0] 
        });
    } catch (error) {
        // Handle unique constraint violation for 'name'
        if (error.code === '23505') {
            return res.status(409).json({ message: 'An item with this name already exists.' });
        }
        console.error('Edit Menu Item Error:', error);
        res.status(500).json({ message: 'Failed to update menu item.' });
    }
});

// --- Daily Menu Management Routes (must be before /menu/:date) ---

/**
 * @route   GET /api/cafeteria/menu/daily-editable/:date
 * @desc    Get the daily menu items grouped by meal type, including item IDs (for editing).
 * @access  Private (Admin, Staff)
 */
router.get('/menu/daily-editable/:date', authenticateToken, authorize(['Admin', 'Staff']), async (req, res) => {
    const menuDate = req.params.date;
    try {
        const query = `
            SELECT 
                dm.id as daily_menu_id,
                dm.meal_type, 
                mi.id as item_id,
                mi.name as item_name, 
                mi.price
            FROM ${DAILY_MENU_TABLE} dm
            JOIN ${MENU_ITEMS_TABLE} mi ON dm.item_id = mi.id
            WHERE dm.menu_date = $1
            ORDER BY dm.meal_type, mi.name;
        `;
        const result = await pool.query(query, [menuDate]);

        // Transform the flat result into a grouped structure: { "Breakfast": [item1, item2], ...}
        const groupedMenu = result.rows.reduce((acc, row) => {
            if (!acc[row.meal_type]) {
                acc[row.meal_type] = [];
            }
            acc[row.meal_type].push({
                daily_menu_id: row.daily_menu_id,
                item_id: row.item_id,
                item_name: row.item_name,
                price: parseFloat(row.price)
            });
            return acc;
        }, {});

        res.status(200).json(groupedMenu);
    } catch (error) {
        console.error('Editable Daily Menu Fetch Error:', error);
        res.status(500).json({ message: 'Failed to retrieve editable daily menu.' });
    }
});

/**
 * @route   POST /api/cafeteria/menu/daily
 * @desc    Create or update the daily menu for a specific date.
 * @access  Private (Admin, Staff)
 * @body    { menu_date: 'YYYY-MM-DD', menu_data: [{ meal_type: 'Breakfast', item_id: 'uuid1' }, ...] }
 */
router.post('/menu/daily', authenticateToken, authorize(['Admin', 'Staff']), async (req, res) => {
    const { menu_date, menu_data } = req.body;

    if (!menu_date || !Array.isArray(menu_data)) {
        return res.status(400).json({ message: 'Missing menu date or menu data array.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Delete existing menu for the date (to support full replacement/editing)
        await client.query(`DELETE FROM ${DAILY_MENU_TABLE} WHERE menu_date = $1`, [menu_date]);

        if (menu_data.length > 0) {
            // 2. Prepare data for bulk insert
            const values = menu_data.map(item => [menu_date, item.meal_type, item.item_id]);
            
            // Create a comma-separated list of ($1, $2, $3), ($4, $5, $6), ... for the VALUES clause
            const insertQueryParts = values.map((_, i) => `($${3 * i + 1}, $${3 * i + 2}, $${3 * i + 3})`).join(', ');
            const flatValues = values.flat();

            const insertQuery = `
                INSERT INTO ${DAILY_MENU_TABLE} (menu_date, meal_type, item_id)
                VALUES ${insertQueryParts}
                ON CONFLICT (menu_date, meal_type, item_id) DO NOTHING;
            `;
            await client.query(insertQuery, flatValues);
        }

        await client.query('COMMIT');
        res.status(201).json({ message: `Daily menu for ${menu_date} successfully saved.` });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Daily Menu Save Error:', error);
        res.status(500).json({ message: 'Failed to save daily menu.' });
    } finally {
        client.release();
    }
});

/**
 * @route   DELETE /api/cafeteria/menu/daily/:date
 * @desc    Delete the daily menu for a specific date.
 * @access  Private (Admin, Staff)
 */
router.delete('/menu/daily/:date', authenticateToken, authorize(['Admin', 'Staff']), async (req, res) => {
    const menuDate = req.params.date;
    try {
        const result = await pool.query(`DELETE FROM ${DAILY_MENU_TABLE} WHERE menu_date = $1 RETURNING *`, [menuDate]);
        if (result.rowCount === 0) {
            return res.status(404).json({ message: `No menu found for ${menuDate}.` });
        }
        res.status(200).json({ message: `Daily menu for ${menuDate} successfully deleted.` });
    } catch (error) {
        console.error('Daily Menu Delete Error:', error);
        res.status(500).json({ message: 'Failed to delete daily menu.' });
    }
});


// --- General Date/Base Menu Routes (Must be LAST in the Menu section) ---

/**
 * @route   GET /api/cafeteria/menu/:date
 * @desc    Get the menu for a specific date.
 * @access  Public
 */
router.get('/menu/:date', async (req, res) => {
    const menuDate = req.params.date;

    try {
        const query = `
            SELECT 
                dm.meal_type, 
                json_agg(json_build_object('item_name', mi.name, 'price', mi.price)) AS items
            FROM ${DAILY_MENU_TABLE} dm
            JOIN ${MENU_ITEMS_TABLE} mi ON dm.item_id = mi.id
            WHERE dm.menu_date = $1
            GROUP BY dm.meal_type
            ORDER BY dm.meal_type;
        `;
        const result = await pool.query(query, [menuDate]);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Menu Fetch Error:', error);
        res.status(500).json({ message: 'Failed to retrieve menu.' });
    }
});

/**
 * @route   GET /api/cafeteria/menu
 * @desc    Get the menu for today (non-parameterized base route).
 * @access  Public
 */
router.get('/menu', async (req, res) => {
    const menuDate = moment().format('YYYY-MM-DD');

    try {
        const query = `
            SELECT 
                dm.meal_type, 
                json_agg(json_build_object('item_name', mi.name, 'price', mi.price)) AS items
            FROM ${DAILY_MENU_TABLE} dm
            JOIN ${MENU_ITEMS_TABLE} mi ON dm.item_id = mi.id
            WHERE dm.menu_date = $1
            GROUP BY dm.meal_type
            ORDER BY dm.meal_type;
        `;
        const result = await pool.query(query, [menuDate]);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Menu Fetch Error (Base):', error);
        res.status(500).json({ message: 'Failed to retrieve menu.' });
    }
});

// =========================================================
// 4. STAFF SHIFT SCHEDULING
// =========================================================

// --- Canteen Staff List Fetch ---

/**
 * @route   GET /api/cafeteria/staff-list
 * @desc    Get staff members belonging to the Canteen/General Staff department.
 * @access  Private (Admin, Staff)
 */
router.get('/staff-list', authenticateToken, authorize(['Admin', 'Staff']), async (req, res) => {
    try {
        const query = `
            SELECT 
                t.user_id AS id, 
                t.full_name AS name,
                d.role AS role,
                t.designation
            FROM ${TEACHERS_TABLE} t
            JOIN ${DEPARTMENTS_TABLE} d ON t.department_id = d.id
            WHERE d.name = 'Canteen Head' OR d.role = 'General Staff'
            ORDER BY t.full_name ASC;
        `;
        const result = await pool.query(query);
        
        // Use user_id for assignment, and full_name for display
        const staffList = result.rows.map(row => ({
            id: row.id, // This is the user_id (UUID) needed for assignments
            name: row.name,
            role: row.role || row.designation // Use the department role or teacher designation
        }));

        res.status(200).json(staffList);
    } catch (error) {
        console.error('Fetch Canteen Staff List Error:', error);
        res.status(500).json({ message: 'Failed to retrieve canteen staff list.' });
    }
});


// --- Shift Type Management (e.g., "Breakfast Shift", "Cleaning Shift") ---

/**
 * @route   POST /api/cafeteria/shifts/type
 * @desc    Create a new permanent shift type.
 * @access  Private (Admin, Staff)
 */
router.post('/shifts/type', authenticateToken, authorize(['Admin', 'Staff']), async (req, res) => {
    const { shift_name, start_time, end_time } = req.body;
    if (!shift_name || !start_time || !end_time) {
        return res.status(400).json({ message: 'Missing shift name, start time, or end time.' });
    }
    try {
        const query = `
            INSERT INTO ${SHIFTS_TABLE} (shift_name, start_time, end_time)
            VALUES ($1, $2, $3)
            RETURNING *;
        `;
        const result = await pool.query(query, [shift_name, start_time, end_time]);
        res.status(201).json({ message: 'Shift type created successfully.', shift: result.rows[0] });
    } catch (error) {
        if (error.code === '23505') { // Unique constraint violation
            return res.status(409).json({ message: 'Shift name already exists.' });
        }
        console.error('Create Shift Error:', error);
        res.status(500).json({ message: 'Failed to create shift type.' });
    }
});

/**
 * @route   GET /api/cafeteria/shifts/type
 * @desc    Get all active shift types.
 * @access  Private (Admin, Staff)
 */
router.get('/shifts/type', authenticateToken, authorize(['Admin', 'Staff']), async (req, res) => {
    try {
        const query = `
            SELECT id, shift_name, start_time, end_time
            FROM ${SHIFTS_TABLE}
            WHERE is_active = TRUE
            ORDER BY start_time;
        `;
        const result = await pool.query(query);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Fetch Shifts Error:', error);
        res.status(500).json({ message: 'Failed to retrieve shift types.' });
    }
});

/**
 * @route   PUT /api/cafeteria/shifts/type/:shiftId
 * @desc    Update details (name, time) of a permanent shift type.
 * @access  Private (Admin)
 */
router.put('/shifts/type/:shiftId', authenticateToken, authorize(['Admin']), async (req, res) => {
    const { shiftId } = req.params;
    const { shift_name, start_time, end_time } = req.body;

    if (!shift_name || !start_time || !end_time) {
        return res.status(400).json({ message: 'Shift name, start time, and end time are required.' });
    }

    try {
        const query = `
            UPDATE ${SHIFTS_TABLE}
            SET shift_name = $1, 
                start_time = $2, 
                end_time = $3
            WHERE id = $4
            RETURNING *;
        `;
        const result = await pool.query(query, [shift_name, start_time, end_time, shiftId]);

        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Shift type not found.' });
        }

        res.status(200).json({ 
            message: 'Shift type updated successfully.', 
            shift: result.rows[0] 
        });
    } catch (error) {
        if (error.code === '23505') { // Unique constraint violation
            return res.status(409).json({ message: 'Shift name already exists.' });
        }
        console.error('Edit Shift Type Error:', error);
        res.status(500).json({ message: 'Failed to update shift type.' });
    }
});

/**
 * @route   PUT /api/cafeteria/shifts/type/toggle/:shiftId
 * @desc    Toggle the active status of a permanent shift type (Deactivate/Activate).
 * @access  Private (Admin)
 */
router.put('/shifts/type/toggle/:shiftId', authenticateToken, authorize(['Admin']), async (req, res) => {
    const { shiftId } = req.params;
    try {
        const query = `
            UPDATE ${SHIFTS_TABLE}
            SET is_active = NOT is_active
            WHERE id = $1
            RETURNING id, is_active, shift_name;
        `;
        const result = await pool.query(query, [shiftId]);

        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Shift type not found.' });
        }

        const newStatus = result.rows[0].is_active ? 'Active' : 'Inactive';
        res.status(200).json({ 
            message: `${result.rows[0].shift_name} set to ${newStatus}.`, 
            is_active: result.rows[0].is_active 
        });
    } catch (error) {
        console.error('Toggle Shift Type Error:', error);
        res.status(500).json({ message: 'Failed to toggle shift status.' });
    }
});


// --- Shift Assignment Management ---

/**
 * @route   POST /api/cafeteria/shifts/assign
 * @desc    Assign a staff member to a shift on a specific date.
 * @access  Private (Admin)
 */
router.post('/shifts/assign', authenticateToken, authorize(['Admin']), async (req, res) => {
    const { shift_date, shift_id, staff_id, notes } = req.body;
    const assignedById = req.user.userId;
    
    if (!shift_date || !shift_id || !staff_id) {
        return res.status(400).json({ message: 'Missing date, shift ID, or staff ID.' });
    }

    try {
        const query = `
            INSERT INTO ${SHIFT_ASSIGNMENTS_TABLE} (shift_date, shift_id, staff_id, notes, assigned_by_id)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING *;
        `;
        const result = await pool.query(query, [shift_date, shift_id, staff_id, notes, assignedById]);
        res.status(201).json({ message: 'Shift assigned successfully.', assignment: result.rows[0] });
    } catch (error) {
        if (error.code === '23505') { // Unique constraint violation (already assigned)
            return res.status(409).json({ message: 'Staff member is already assigned to this shift on this date.' });
        }
        console.error('Shift Assignment Error:', error);
        res.status(500).json({ message: 'Failed to assign shift.' });
    }
});

/**
 * @route   GET /api/cafeteria/shifts/schedule/:date
 * @desc    Get the full shift schedule for a specific date.
 * @access  Private (Admin, Staff)
 */
router.get('/shifts/schedule/:date', authenticateToken, authorize(['Admin', 'Staff']), async (req, res) => {
    const shiftDate = req.params.date;
    try {
        const query = `
            SELECT 
                sa.id AS assignment_id,
                s.shift_name, 
                s.start_time, 
                s.end_time,
                sa.staff_id,
                t.full_name AS staff_name, 
                sa.notes
            FROM ${SHIFT_ASSIGNMENTS_TABLE} sa
            JOIN ${SHIFTS_TABLE} s ON sa.shift_id = s.id
            JOIN ${TEACHERS_TABLE} t ON sa.staff_id = t.user_id
            WHERE sa.shift_date = $1
            ORDER BY s.start_time, s.shift_name;
        `;
        const result = await pool.query(query, [shiftDate]);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Fetch Schedule Error:', error);
        res.status(500).json({ message: 'Failed to retrieve shift schedule.' });
    }
});

/**
 * @route   DELETE /api/cafeteria/shifts/assignment/:assignmentId
 * @desc    Delete a specific shift assignment.
 * @access  Private (Admin)
 */
router.delete('/shifts/assignment/:assignmentId', authenticateToken, authorize(['Admin']), async (req, res) => {
    const { assignmentId } = req.params;
    try {
        const result = await pool.query(`DELETE FROM ${SHIFT_ASSIGNMENTS_TABLE} WHERE id = $1 RETURNING *`, [assignmentId]);
        
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Shift assignment not found.' });
        }
        res.status(200).json({ message: 'Shift assignment deleted successfully.' });
    } catch (error) {
        console.error('Delete Assignment Error:', error);
        res.status(500).json({ message: 'Failed to delete shift assignment.' });
    }
});


// =========================================================
// 5. TRANSACTION HISTORY
// =========================================================

/**
 * @route   GET /api/cafeteria/transactions/:userId
 * @desc    Get user's transaction history.
 * @access  Private (Self, Admin, Staff)
 */
router.get('/transactions/:userId', authenticateToken, async (req, res) => {
    const { userId } = req.params;
    const requesterId = req.user.userId;
    const requesterRole = req.user.role;
    
    if (userId !== requesterId && requesterRole !== 'Admin' && requesterRole !== 'Staff') {
        return res.status(403).json({ message: 'Access denied.' });
    }

    try {
        const query = `
            SELECT id, type, amount, current_balance_after, created_at
            FROM ${TRANSACTIONS_TABLE}
            WHERE user_id = $1
            ORDER BY created_at DESC;
        `;
        const result = await pool.query(query, [userId]);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Transaction History Fetch Error:', error);
        res.status(500).json({ message: 'Failed to retrieve transaction history.' });
    }
});

// =========================================================
// 6. REPORTING & ANALYTICS
// =========================================================

/**
 * @route   GET /api/cafeteria/reports/sales-summary
 * @desc    Get total sales and top-ups within a date range.
 * @access  Private (Admin)
 * @query   ?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
 */
router.get('/reports/sales-summary', authenticateToken, authorize(['Admin']), async (req, res) => {
    const { start_date, end_date } = req.query;

    if (!start_date || !end_date) {
        return res.status(400).json({ message: 'Start date and end date are required.' });
    }

    try {
        const query = `
            SELECT
                t.type,
                COUNT(t.id) AS transaction_count,
                SUM(t.amount) AS total_amount
            FROM ${TRANSACTIONS_TABLE} t
            WHERE t.created_at::date BETWEEN $1 AND $2
            AND t.type IN ('PURCHASE', 'TOP_UP')
            GROUP BY t.type;
        `;
        const result = await pool.query(query, [start_date, end_date]);

        const summary = result.rows.reduce((acc, row) => {
            acc[row.type] = {
                count: parseInt(row.transaction_count),
                total: parseFloat(row.total_amount)
            };
            return acc;
        }, { PURCHASE: { count: 0, total: 0.00 }, TOP_UP: { count: 0, total: 0.00 } });

        res.status(200).json(summary);
    } catch (error) {
        console.error('Sales Summary Report Error:', error);
        res.status(500).json({ message: 'Failed to generate sales summary report.' });
    }
});

/**
 * @route   GET /api/cafeteria/reports/top-selling-items
 * @desc    Get top 5 purchased items within a date range.
 * @access  Private (Admin)
 * @query   ?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
 */
router.get('/reports/top-selling-items', authenticateToken, authorize(['Admin']), async (req, res) => {
    const { start_date, end_date } = req.query;

    if (!start_date || !end_date) {
        return res.status(400).json({ message: 'Start date and end date are required.' });
    }
    
    try {
        const query = `
            WITH purchased_items AS (
                SELECT
                    jsonb_array_elements(t.order_details_json) AS item_data
                FROM ${TRANSACTIONS_TABLE} t
                WHERE t.type = 'PURCHASE'
                AND t.created_at::date BETWEEN $1 AND $2
            )
            SELECT
                (item_data->>'name') AS item_name,
                SUM((item_data->>'quantity')::numeric) AS total_quantity_sold
            FROM purchased_items
            GROUP BY item_name
            ORDER BY total_quantity_sold DESC
            LIMIT 5;
        `;
        const result = await pool.query(query, [start_date, end_date]);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Top Selling Items Report Error:', error);
        res.status(500).json({ message: 'Failed to generate top selling items report.' });
    }
});

/**
 * @route   GET /api/cafeteria/reports/staff-hours
 * @desc    Get total hours scheduled per staff member within a date range.
 * @access  Private (Admin)
 * @query   ?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
 */
router.get('/reports/staff-hours', authenticateToken, authorize(['Admin']), async (req, res) => {
    const { start_date, end_date } = req.query;

    if (!start_date || !end_date) {
        return res.status(400).json({ message: 'Start date and end date are required.' });
    }
    
    try {
        const query = `
            SELECT
                t.full_name AS staff_name,
                COUNT(sa.id) AS shifts_assigned,
                SUM(EXTRACT(EPOCH FROM (s.end_time - s.start_time)) / 3600) AS total_hours_scheduled
            FROM ${SHIFT_ASSIGNMENTS_TABLE} sa
            JOIN ${SHIFTS_TABLE} s ON sa.shift_id = s.id
            JOIN ${TEACHERS_TABLE} t ON sa.staff_id = t.user_id
            WHERE sa.shift_date BETWEEN $1 AND $2
            GROUP BY t.full_name
            ORDER BY total_hours_scheduled DESC;
        `;
        const result = await pool.query(query, [start_date, end_date]);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Staff Hours Report Error:', error);
        res.status(500).json({ message: 'Failed to generate staff hours report.' });
    }
});

module.exports = router;