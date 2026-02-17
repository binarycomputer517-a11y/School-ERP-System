// routes/systemLogs.js

const express = require('express');
const router = express.Router();
const { authenticateToken, authorize } = require('../authMiddleware');
const { pool } = require('../database');

const LOGS_TABLE = 'audit_logs'; 

/**
 * @route GET /api/system/logs
 * @desc Get system, security, and access logs.
 * @access Private (Super Admin, IT Helpdesk)
 */
router.get('/', authenticateToken, authorize(['Super Admin', 'IT Helpdesk']), async (req, res) => {
    // Frontend passes 'level' and 'startDate'
    const { level = '', startDate = '1970-01-01', query = '' } = req.query;
    
    try {
        let sql = `
            SELECT 
                id, 
                -- 1. Map 'created_at' to 'timestamp'
                created_at AS timestamp, 
                -- 2. Map 'action_type' to 'level' (for frontend filter/display)
                action_type AS level, 
                user_id, 
                -- 3. Use 'target_table' as the source for simplicity
                target_table AS source, 
                -- 4. Use action_type and target_table to construct the message
                action_type || ' on table: ' || target_table AS message, 
                -- 5. Use 'details' (JSONB) and ip_address as 'context'
                jsonb_build_object('details', details, 'ip_address', ip_address) AS context
            FROM ${LOGS_TABLE}
            -- Filter using the actual column name 'created_at'
            WHERE created_at::date >= $1::date
        `;
        const params = [startDate];
        let paramIndex = 2;

        if (level) {
            // Filter SQL uses the actual column name 'action_type'
            sql += ` AND action_type = $${paramIndex++}`;
            params.push(level);
        }
        
        if (query) {
            // Search based on action_type or target_table
            sql += ` AND (LOWER(action_type) LIKE $${paramIndex} OR LOWER(target_table) LIKE $${paramIndex})`;
            params.push(`%${query.toLowerCase()}%`);
        }
        
        // Order by the actual column 'created_at'
        sql += ` ORDER BY created_at DESC LIMIT 200;`;

        const result = await pool.query(sql, params);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('CRITICAL Error fetching system logs:', error);
        res.status(500).json({ message: 'Failed to retrieve system logs.' });
    }
});

module.exports = router;