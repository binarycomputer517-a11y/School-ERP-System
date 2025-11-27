const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken, authorize } = require('../authMiddleware');

// ==========================================
// 1. CUSTOMER LOOKUP
// ==========================================
router.get('/customers', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(`SELECT id, username, full_name, role FROM users WHERE is_active = TRUE ORDER BY username ASC`);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ message: err.message }); }
});

// ==========================================
// 2. MENU MANAGEMENT
// ==========================================
router.get('/menu/items', authenticateToken, authorize(['Admin', 'Staff']), async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM cafeteria_menu_items ORDER BY name ASC');
        res.json(result.rows);
    } catch (err) { res.status(500).json({ message: err.message }); }
});

router.post('/menu/add-item', authenticateToken, authorize(['Admin', 'Staff']), async (req, res) => {
    const { name, price, category, food_type, allergens, calories } = req.body;
    try {
        const result = await pool.query(
            `INSERT INTO cafeteria_menu_items (name, price, category, food_type, allergens, calories) 
            VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
            [name, price, category, food_type || 'Veg', allergens, calories || 0]
        );
        res.status(201).json({ message: 'Item added', item: result.rows[0] });
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ message: 'Item name exists' });
        res.status(500).json({ message: err.message });
    }
});

router.put('/menu/edit-item/:id', authenticateToken, authorize(['Admin', 'Staff']), async (req, res) => {
    const { name, price, category, food_type, allergens, calories } = req.body;
    try {
        await pool.query(
            `UPDATE cafeteria_menu_items SET name=$1, price=$2, category=$3, food_type=$4, allergens=$5, calories=$6 WHERE id=$7`,
            [name, price, category, food_type, allergens, calories, req.params.id]
        );
        res.json({ message: 'Item updated' });
    } catch (err) { res.status(500).json({ message: err.message }); }
});

router.put('/menu/toggle-availability/:id', authenticateToken, authorize(['Admin', 'Staff']), async (req, res) => {
    try {
        await pool.query('UPDATE cafeteria_menu_items SET is_available = NOT is_available WHERE id = $1', [req.params.id]);
        res.json({ message: 'Status toggled' });
    } catch (err) { res.status(500).json({ message: err.message }); }
});

// ==========================================
// 3. DAILY PLANNER
// ==========================================
router.get('/menu/:date', async (req, res) => {
    try {
        const query = `
            SELECT dm.meal_type, json_agg(json_build_object('menu_item_id', mi.id, 'item_name', mi.name, 'price', mi.price, 'food_type', mi.food_type)) as items
            FROM cafeteria_daily_menu dm
            JOIN cafeteria_menu_items mi ON dm.item_id = mi.id
            WHERE dm.menu_date = $1 GROUP BY dm.meal_type
        `;
        const result = await pool.query(query, [req.params.date]);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get('/menu/daily-editable/:date', authenticateToken, authorize(['Admin', 'Staff']), async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT dm.meal_type, mi.id as item_id, mi.name as item_name
            FROM cafeteria_daily_menu dm
            JOIN cafeteria_menu_items mi ON dm.item_id = mi.id
            WHERE dm.menu_date = $1
        `, [req.params.date]);
        
        const grouped = result.rows.reduce((acc, row) => {
            if(!acc[row.meal_type]) acc[row.meal_type] = [];
            acc[row.meal_type].push(row);
            return acc;
        }, {});
        res.json(grouped);
    } catch (err) { res.status(500).json({ message: err.message }); }
});

router.post('/menu/daily', authenticateToken, authorize(['Admin', 'Staff']), async (req, res) => {
    const { menu_date, menu_data } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('DELETE FROM cafeteria_daily_menu WHERE menu_date = $1', [menu_date]);
        for(const item of menu_data) {
            await client.query('INSERT INTO cafeteria_daily_menu (menu_date, meal_type, item_id) VALUES ($1, $2, $3)', [menu_date, item.meal_type, item.item_id]);
        }
        await client.query('COMMIT');
        res.json({ message: 'Menu published' });
    } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ message: err.message }); }
    finally { client.release(); }
});

router.delete('/menu/daily/:date', authenticateToken, authorize(['Admin', 'Staff']), async (req, res) => {
    try {
        await pool.query('DELETE FROM cafeteria_daily_menu WHERE menu_date = $1', [req.params.date]);
        res.json({ message: 'Menu cleared' });
    } catch (err) { res.status(500).json({ message: err.message }); }
});

// ==========================================
// 4. POS & ORDERING (Fixed User ID Logic)
// ==========================================
router.get('/balance/:id', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query('SELECT balance FROM cafeteria_accounts WHERE user_id = $1', [req.params.id]);
        res.json({ current_balance: result.rows[0]?.balance || "0.00" });
    } catch (err) { res.status(500).json({ message: err.message }); }
});

router.post('/top-up', authenticateToken, authorize(['Admin', 'Staff']), async (req, res) => {
    const { user_id, amount, payment_method } = req.body;
    // FIX: Use req.user.id instead of req.user.userId
    const adminId = req.user.id || req.user.userId; 

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const resAcc = await client.query(`
            INSERT INTO cafeteria_accounts (user_id, balance) VALUES ($1, $2)
            ON CONFLICT (user_id) DO UPDATE SET balance = cafeteria_accounts.balance + $2
            RETURNING balance
        `, [user_id, amount]);
        
        await client.query(`
            INSERT INTO cafeteria_transactions (user_id, type, amount, current_balance_after, recorded_by_id, notes, order_status)
            VALUES ($1, 'TOP_UP', $2, $3, $4, $5, 'COMPLETED')
        `, [user_id, amount, resAcc.rows[0].balance, adminId, payment_method]);
        
        await client.query('COMMIT');
        res.json({ new_balance: resAcc.rows[0].balance });
    } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ message: err.message }); }
    finally { client.release(); }
});

router.post('/order', authenticateToken, authorize(['Admin', 'Staff', 'Student']), async (req, res) => {
    const { user_id, total_cost, order_items } = req.body;
    // FIX: Use req.user.id
    const recordedBy = req.user.id || req.user.userId;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        // 1. Balance Deduction
        const acc = await client.query('SELECT balance FROM cafeteria_accounts WHERE user_id = $1 FOR UPDATE', [user_id]);
        const bal = parseFloat(acc.rows[0]?.balance || 0);
        if(bal < total_cost) throw new Error(`Insufficient Balance (Current: ₹${bal})`);
        
        const newBal = bal - total_cost;
        await client.query('UPDATE cafeteria_accounts SET balance = $1 WHERE user_id = $2', [newBal, user_id]);
        
        // 2. Inventory Deduction
        for(const item of order_items) {
            const recipes = await client.query('SELECT inventory_item_id, quantity_required FROM cafeteria_recipes WHERE menu_item_id = $1', [item.menu_item_id]);
            for(const r of recipes.rows) {
                const deduct = r.quantity_required * item.quantity;
                
                const invUp = await client.query(
                    'UPDATE inventory_items SET quantity_on_hand = quantity_on_hand - $1 WHERE id = $2 RETURNING quantity_on_hand',
                    [deduct, r.inventory_item_id]
                );
                
                const newStock = invUp.rows[0].quantity_on_hand;

                // Log Movement (FIX: Fixed column names & user ID)
                await client.query(`
                    INSERT INTO inventory_movement 
                    (item_id, movement_type, type, quantity_changed, current_stock_after, recorded_by_id, notes) 
                    VALUES ($1, 'SALE', 'OUT', $2, $3, $4, 'Cafeteria Sale')
                `, [r.inventory_item_id, deduct, newStock, recordedBy]);
            }
        }
        
        // 3. Transaction Record
        await client.query(`
            INSERT INTO cafeteria_transactions 
            (user_id, type, amount, current_balance_after, recorded_by_id, order_details_json, order_status)
            VALUES ($1, 'PURCHASE', $2, $3, $4, $5, 'PENDING')
        `, [user_id, total_cost, newBal, recordedBy, JSON.stringify(order_items)]);
        
        await client.query('COMMIT');
        res.json({ new_balance: newBal });
    } catch (err) { await client.query('ROLLBACK'); res.status(400).json({ message: err.message }); }
    finally { client.release(); }
});

// ==========================================
// 5. KITCHEN DISPLAY
// ==========================================
router.get('/kds/live', authenticateToken, authorize(['Admin', 'Staff']), async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT t.id, t.order_status, t.created_at, u.username as customer_name, t.order_details_json
            FROM cafeteria_transactions t
            LEFT JOIN users u ON t.user_id = u.id
            WHERE t.type = 'PURCHASE' AND t.order_status IN ('PENDING', 'PREPARING')
            ORDER BY t.created_at ASC
        `);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ message: err.message }); }
});

router.put('/kds/status/:id', authenticateToken, authorize(['Admin', 'Staff']), async (req, res) => {
    try {
        await pool.query('UPDATE cafeteria_transactions SET order_status = $1 WHERE id = $2', [req.body.status, req.params.id]);
        res.json({ message: 'Order status updated' });
    } catch (err) { res.status(500).json({ message: err.message }); }
});

// ==========================================
// 6. RECIPES
// ==========================================
router.post('/recipe', authenticateToken, authorize(['Admin', 'Staff']), async (req, res) => {
    try {
        await pool.query(`INSERT INTO cafeteria_recipes (menu_item_id, inventory_item_id, quantity_required) VALUES ($1, $2, $3) ON CONFLICT (menu_item_id, inventory_item_id) DO UPDATE SET quantity_required = $3`, 
        [req.body.menu_item_id, req.body.inventory_item_id, req.body.quantity]);
        res.json({ message: 'Ingredient linked' });
    } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get('/recipe/:id', authenticateToken, async (req, res) => {
    try {
        const r = await pool.query(`SELECT r.quantity_required, i.name as ingredient_name, i.unit FROM cafeteria_recipes r JOIN inventory_items i ON r.inventory_item_id = i.id WHERE r.menu_item_id = $1`, [req.params.id]);
        res.json(r.rows);
    } catch (err) { res.status(500).json({ message: err.message }); }
});

// ==========================================
// 7. STAFF SHIFTS & REPORTS
// ==========================================
router.get('/staff-list', authenticateToken, async(req,res)=> {
    const r = await pool.query("SELECT id, username as name, role FROM users WHERE role IN ('Staff', 'Admin', 'Teacher')");
    res.json(r.rows);
});

router.get('/shifts/type', authenticateToken, async(req,res)=> {
    try {
        const r = await pool.query('SELECT * FROM cafeteria_shifts WHERE is_active = TRUE ORDER BY start_time'); 
        res.json(r.rows);
    } catch(e) { res.status(500).json({message: e.message}); }
});

router.post('/shifts/type', authenticateToken, async(req,res)=> {
    try {
        await pool.query('INSERT INTO cafeteria_shifts (shift_name, start_time, end_time) VALUES ($1,$2,$3)', [req.body.shift_name, req.body.start_time, req.body.end_time]);
        res.json({message:'Created'});
    } catch(e) { res.status(500).json({message: e.message}); }
});

router.get('/shifts/schedule/:date', authenticateToken, async(req,res)=> {
    try {
        const r = await pool.query(`SELECT sa.id as assignment_id, s.shift_name, u.username as staff_name, s.start_time, s.end_time FROM cafeteria_shift_assignments sa JOIN cafeteria_shifts s ON sa.shift_id = s.id JOIN users u ON sa.staff_id = u.id WHERE sa.shift_date = $1 ORDER BY s.start_time`, [req.params.date]);
        res.json(r.rows);
    } catch(e) { res.status(500).json({message: e.message}); }
});

router.post('/shifts/assign', authenticateToken, async(req,res)=> {
    const adminId = req.user.id || req.user.userId;
    try {
        await pool.query('INSERT INTO cafeteria_shift_assignments (shift_date, shift_id, staff_id, notes, assigned_by_id) VALUES ($1,$2,$3,$4,$5)', 
            [req.body.shift_date, req.body.shift_id, req.body.staff_id, req.body.notes, adminId]);
        res.json({message:'Assigned'});
    } catch(e) { 
        if(e.code === '23505') return res.status(409).json({message:'Already assigned'});
        res.status(500).json({message: e.message}); 
    }
});

router.delete('/shifts/assignment/:id', authenticateToken, async(req,res)=> {
    await pool.query('DELETE FROM cafeteria_shift_assignments WHERE id=$1', [req.params.id]);
    res.json({message:'Deleted'});
});

router.get('/reports/sales-summary', authenticateToken, async(req,res)=> {
    try {
        const r = await pool.query(`SELECT type, SUM(amount) as total FROM cafeteria_transactions WHERE created_at::date BETWEEN $1 AND $2 GROUP BY type`, [req.query.start_date, req.query.end_date]);
        const summary = { PURCHASE: { total:0 }, TOP_UP: { total:0 } };
        r.rows.forEach(row => summary[row.type] = { total: row.total });
        res.json(summary);
    } catch(e) { res.status(500).json({message: e.message}); }
});

router.get('/reports/top-selling-items', authenticateToken, async(req,res)=> {
    try {
        const r = await pool.query(`WITH items AS (SELECT jsonb_array_elements(order_details_json) as item FROM cafeteria_transactions WHERE type='PURCHASE' AND created_at::date BETWEEN $1 AND $2) SELECT item->>'name' as item_name, SUM((item->>'quantity')::int) as total_quantity_sold FROM items GROUP BY item_name ORDER BY total_quantity_sold DESC LIMIT 5`, [req.query.start_date, req.query.end_date]);
        res.json(r.rows);
    } catch(e) { res.status(500).json({message: e.message}); }
});

module.exports = router;