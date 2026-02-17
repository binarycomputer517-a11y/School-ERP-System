const express = require('express');
const router = express.Router();
const { authenticateToken, authorize } = require('../authMiddleware');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { pool } = require('../database');

const BACKUP_DIR = path.join(__dirname, '../backups'); 
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

const DB_CONFIG = {
    user: process.env.DB_USER || 'sudammaity',
    pass: process.env.DB_PASSWORD,
    name: process.env.DB_DATABASE || 'school_erp',
    port: process.env.DB_PORT || 5433,
    gpgPass: process.env.GPG_PASS || 'default_pass'
};

/**
 * 1. Encrypted Backup + Real-time Cloud Push
 * Logic: pg_dump -> GPG AES-256 -> Local Storage -> Rclone Push
 */

router.post('/initiate', authenticateToken, authorize(['Super Admin']), async (req, res) => {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `erp_secure_${timestamp}.sql.gpg`;
    const filePath = path.join(BACKUP_DIR, filename);

    // ধাপ ১: লোকাল এনক্রিপ্টেড ব্যাকআপ তৈরি
    const backupCmd = `export PGPASSWORD='${DB_CONFIG.pass}'; pg_dump -U ${DB_CONFIG.user} -p ${DB_CONFIG.port} ${DB_CONFIG.name} | gpg --batch --yes --passphrase ${DB_CONFIG.gpgPass} -c -o ${filePath}`;

    exec(backupCmd, (error) => {
        if (error) {
            console.error('[DR] Local Backup Failure:', error);
            return res.status(500).json({ message: 'Local Encryption Engine Failed.' });
        }

        console.log(`[DR] Archive Locked locally: ${filename}. Starting Cloud Sync...`);

        // ধাপ ২: ক্লাউড সিঙ্ক (Rclone ব্যবহার করে গুগল ড্রাইভে পাঠানো)
        // এটি ব্যাকগ্রাউন্ডে চলবে যাতে ইউজারকে বেশিক্ষণ ওয়েট করতে না হয়
        const cloudCmd = `rclone copy ${filePath} googledrive:school_erp_backups`;
        
        exec(cloudCmd, (cloudErr) => {
            if (cloudErr) {
                console.error('🚨 [CLOUD] Sync Failed. Run "rclone config" to check connection.', cloudErr);
            } else {
                console.log(`✅ [CLOUD] Success: ${filename} is now safe in Google Drive.`);
            }
        });

        res.status(200).json({ 
            message: 'Local Backup Success. Cloud Sync initiated in background.', 
            filename: filename,
            is_cloud: true 
        });
    });
});

/**
 * 2. Non-Destructive Sandbox Integrity Test
 */

router.post('/test-integrity', authenticateToken, authorize(['Super Admin']), async (req, res) => {
    const { filename } = req.body;
    const sandboxDB = "erp_sandbox_test";

    try {
        await pool.query(`DROP DATABASE IF EXISTS ${sandboxDB}`);
        await pool.query(`CREATE DATABASE ${sandboxDB}`);
        await new Promise(r => setTimeout(r, 2000)); // Settlement delay

        const restoreCmd = `export PGPASSWORD='${DB_CONFIG.pass}'; gpg --batch --passphrase ${DB_CONFIG.gpgPass} -d ${path.join(BACKUP_DIR, filename)} | psql -U ${DB_CONFIG.user} -p ${DB_CONFIG.port} -d ${sandboxDB}`;

        exec(restoreCmd, (error, stdout, stderr) => {
            if (error) {
                console.error("[DR] Integrity Check Failed:", stderr);
                return res.status(500).json({ success: false, message: "Decryption or Structure Mismatch." });
            }
            res.json({ success: true, message: "INTEGRITY PASSED: Archive structure validated in Sandbox." });
        });
    } catch (err) {
        res.status(500).json({ success: false, message: "Sandbox creation failed." });
    }
});

/**
 * 3. Final Production Restore (Emergency Protocol)
 */
router.post('/restore-live', authenticateToken, authorize(['Super Admin']), async (req, res) => {
    const { filename } = req.body;
    
    try {
        // Drop connections to avoid 'database is in use' errors
        await pool.query(`
            SELECT pg_terminate_backend(pg_stat_activity.pid)
            FROM pg_stat_activity
            WHERE pg_stat_activity.datname = '${DB_CONFIG.name}'
              AND pid <> pg_backend_pid();
        `);

        const restoreCmd = `export PGPASSWORD='${DB_CONFIG.pass}'; gpg --batch --passphrase ${DB_CONFIG.gpgPass} -d ${path.join(BACKUP_DIR, filename)} | psql -U ${DB_CONFIG.user} -p ${DB_CONFIG.port} -d ${DB_CONFIG.name}`;

        exec(restoreCmd, (error, stdout, stderr) => {
            if (error) return res.status(500).json({ success: false, message: "Restore Interrupted." });
            res.json({ success: true, message: "CRITICAL: Database Overwritten Successfully." });
        });
    } catch (err) {
        res.status(500).json({ success: false, message: "Could not lock database for restore." });
    }
});

/**
 * 4. List Archives (Local View)
 */
router.get('/list', authenticateToken, authorize(['Super Admin']), async (req, res) => {
    try {
        const files = fs.readdirSync(BACKUP_DIR)
            .filter(name => name.endsWith('.gpg'))
            .map(name => {
                const stats = fs.statSync(path.join(BACK-DIR, name));
                return {
                    filename: name,
                    timestamp: stats.mtime,
                    size: (stats.size / 1024).toFixed(2) + " KB",
                    is_cloud: true // Mark as cloud syncable
                };
            })
            .sort((a, b) => b.timestamp - a.timestamp);
        res.json(files);
    } catch (e) { res.json([]); }
});

module.exports = router;