const express = require('express');
const router = express.Router();
const { pool } = require('../database');

// ===========================================
// 1. GET ALL FIXED ASSETS (With Depreciation)
// ===========================================
router.get('/', async (req, res) => {
    try {
        // শুধুমাত্র FIXED_ASSET টাইপের আইটেমগুলো আনা হচ্ছে
        const result = await pool.query(
            `SELECT id, item_name, sku_code, unit_price, depreciation_rate, 
                    created_at as purchase_date, location_aisle, location_bin, image_url 
             FROM inventory_items 
             WHERE item_type = 'FIXED_ASSET'
             ORDER BY created_at DESC`
        );

        // ক্যালকুলেশন: বর্তমান দাম কত? (Formula: Price * (1 - rate)^years)
        const assets = result.rows.map(asset => {
            const purchaseDate = new Date(asset.purchase_date);
            const today = new Date();
            const ageInYears = (today - purchaseDate) / (1000 * 60 * 60 * 24 * 365);
            
            let currentValue = parseFloat(asset.unit_price);
            
            // যদি Depreciation Rate থাকে (যেমন ১০%)
            if (asset.depreciation_rate > 0) {
                currentValue = asset.unit_price * Math.pow((1 - asset.depreciation_rate / 100), ageInYears);
            }
            
            return {
                ...asset,
                current_value: currentValue.toFixed(2),
                age: ageInYears.toFixed(1) + ' Years'
            };
        });

        res.json(assets);
    } catch (err) {
        console.error("Asset Fetch Error:", err);
        res.status(500).json({ error: 'Server Error' });
    }
});

// ===========================================
// 2. ADD MAINTENANCE LOG (মেরামতের তথ্য)
// ===========================================
router.post('/maintenance', async (req, res) => {
    const { asset_id, issue_description, cost, performed_by, date } = req.body;
    try {
        await pool.query(
            `INSERT INTO asset_maintenance_log 
            (asset_id, issue_description, cost, performed_by, maintenance_date)
             VALUES ($1, $2, $3, $4, $5)`,
            [asset_id, issue_description, cost, performed_by, date || new Date()]
        );
        res.json({ success: true, message: 'Maintenance log added successfully' });
    } catch (err) {
        console.error("Maintenance Log Error:", err);
        res.status(500).json({ error: 'Server Error' });
    }
});

// ===========================================
// 3. GET MAINTENANCE HISTORY (মেরামতের ইতিহাস)
// ===========================================
router.get('/maintenance/:assetId', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT * FROM asset_maintenance_log 
             WHERE asset_id = $1 
             ORDER BY maintenance_date DESC`,
            [req.params.assetId]
        );
        res.json(result.rows);
    } catch (err) {
        console.error("Fetch Log Error:", err);
        res.status(500).json({ error: 'Server Error' });
    }
});

module.exports = router;