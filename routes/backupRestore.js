// routes/backupRestore.js

const express = require('express');
const router = express.Router();
const { authenticateToken, authorize } = require('../authMiddleware');
const fs = require('fs');
const path = require('path');

// NOTE: __dirname is routes/, so ../backups is sibling to routes/
const BACKUP_DIR = path.join(__dirname, '../backups'); 
// Ensure the backups directory exists
if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

/**
 * @route POST /api/system/backup/initiate
 * @desc Triggers a manual database backup (Now actually writes a placeholder file).
 * @access Private (Super Admin, IT Helpdesk)
 */
router.post('/initiate', authenticateToken, authorize(['Super Admin', 'IT Helpdesk']), async (req, res) => {
    try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `erp_backup_${timestamp}.sql`;
        const filePath = path.join(BACKUP_DIR, filename);
        
        // --- ACTUAL FILE WRITE (SIMULATED DUMP) ---
        // This is the FIX: Write a small placeholder file so the GET route can find it.
        const simulatedContent = `-- School ERP Simulated Database Backup Dump\n-- Timestamp: ${timestamp}`;
        fs.writeFileSync(filePath, simulatedContent); 
        
        // Simulating the operation time (kept for UX)
        await new Promise(resolve => setTimeout(resolve, 1500)); 
        
        // Simulating success
        res.status(200).json({
            message: 'Backup initiated successfully.',
            filename: filename,
            path: filePath
        });
    } catch (error) {
        console.error('Backup Initiation Error:', error);
        res.status(500).json({ message: 'Backup failed during processing.' });
    }
});

/**
 * @route GET /api/system/backup/list
 * @desc Lists recent backup files.
 * @access Private (Super Admin, IT Helpdesk)
 */
router.get('/list', authenticateToken, authorize(['Super Admin', 'IT Helpdesk']), async (req, res) => {
    try {
        // List files in the backups directory and extract metadata
        const files = fs.readdirSync(BACKUP_DIR)
            .filter(name => name.endsWith('.sql') || name.endsWith('.bak'))
            .map(name => {
                const stats = fs.statSync(path.join(BACKUP_DIR, name));
                return {
                    filename: name,
                    timestamp: stats.mtime,
                    size: stats.size // size in bytes
                };
            })
            .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)); // Sort newest first

        res.status(200).json(files);
    } catch (error) {
        if (error.code === 'ENOENT') {
            return res.status(200).json([]);
        }
        console.error('Backup List Error:', error);
        res.status(500).json({ message: 'Failed to retrieve backup list.' });
    }
});

module.exports = router;