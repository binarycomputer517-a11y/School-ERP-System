// /routes/sections.js

const express = require('express');
const router = express.Router();
const pool = require('../database').pool;

// --- GET: একটি নির্দিষ্ট ক্লাসের সমস্ত সেকশন ---
// পাথ: GET /api/sections/by-class/:classId
router.get('/by-class/:classId', async (req, res) => {
    try {
        const { classId } = req.params;
        // এই কোয়েরিটি পরিবর্তন করা হয়েছে
        const query = `
            SELECT id, section_name 
            FROM sections 
            WHERE class_id = $1
            ORDER BY section_name;
        `;
        
        const { rows } = await pool.query(query, [classId]);
        res.status(200).json(rows);
    } catch (err) {
        console.error('Error fetching sections by class:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

module.exports = router;