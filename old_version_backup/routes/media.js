// routes/media.js
const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken, authorize } = require('../authMiddleware'); 
const path = require('path');
const fs = require('fs/promises'); // Use promises version of fs for async deletion

// Define the directory name for media uploads relative to /uploads
const MEDIA_UPLOAD_DIR = 'media';
const UPLOADS_PATH = path.join(__dirname, '..', 'uploads', MEDIA_UPLOAD_DIR);

// --- Helper function to get Multer instance ---
function getMediaUploader(req) {
    const baseMulter = req.app.get('upload');
    // Configure it for a single field named 'file'
    return baseMulter.single('file');
}

// --- Role Definitions ---
const UPLOAD_ROLES = ['Admin', 'Super Admin', 'Librarian', 'Teacher'];
const ADMIN_ROLES = ['Admin', 'Super Admin'];


// ===========================================
// 1. GENERAL GALLERY Route: Fetch Media Items
// ===========================================

router.get('/', authenticateToken, async (req, res) => {
    try {
        // Query the media table for items that the user is authorized to see
        const result = await pool.query(`
            SELECT 
                id, title, media_type, file_path, upload_date, access_level
            FROM media
            WHERE access_level = 'Public' OR user_id = $1::uuid
            ORDER BY upload_date DESC;
        `, [req.user.id]);

        res.status(200).json(result.rows); 
    } catch (err) {
        console.error('Error fetching media gallery:', err);
        res.status(500).json({ error: 'Server error fetching media', details: err.message });
    }
});


// ===========================================
// 2. GENERAL UPLOAD Route: Handle Media Upload
// ===========================================

router.post('/upload', authenticateToken, authorize(UPLOAD_ROLES), async (req, res) => {
    const upload = getMediaUploader(req);

    upload(req, res, async function (err) {
        if (err) {
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(400).json({ error: 'File size limit exceeded (max 10MB).' });
            }
            console.error('Multer upload error:', err);
            return res.status(500).json({ error: 'File upload failed.', details: err.message });
        }

        if (!req.file) {
            return res.status(400).json({ error: 'No file selected for upload.' });
        }
        
        const { title, description, media_type, access_level } = req.body;
        const relativeFilePath = path.join(MEDIA_UPLOAD_DIR, req.file.filename);
        
        if (!title || !media_type) {
            return res.status(400).json({ error: 'Missing required fields: Title and Media Type.' });
        }

        try {
            const result = await pool.query(
                `INSERT INTO media (user_id, title, description, file_path, media_type, access_level, upload_date)
                 VALUES ($1, $2, $3, $4, $5, $6, NOW())
                 RETURNING id`,
                [req.user.id, title, description, relativeFilePath, media_type, access_level || 'Public']
            );

            res.status(201).json({ 
                message: 'Media uploaded successfully.', 
                mediaId: result.rows[0].id 
            });

        } catch (dbErr) {
            console.error('Database error saving media metadata:', dbErr);
            // Attempt to delete the file if metadata saving fails
            try { await fs.unlink(req.file.path); } catch(e) { console.error('Failed to delete file after DB error:', e); }
            res.status(500).json({ error: 'Failed to record media in database.', details: dbErr.message });
        }
    });
});


// ===========================================
// 3. EBOOK SPECIFIC ROUTES (New Functionality)
// ===========================================

/**
 * @route   POST /api/media/upload/ebook
 * @desc    Handle Ebook file upload and metadata saving.
 * @access  Private (Admin, Librarian, Teacher)
 */
router.post('/upload/ebook', authenticateToken, authorize(UPLOAD_ROLES), async (req, res) => {
    // Uses the same Multer instance
    const upload = getMediaUploader(req);

    upload(req, res, async function (err) {
        if (err) {
             // Specific Multer error handling
            if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'File size limit exceeded.' });
            return res.status(500).json({ error: 'File upload failed.', details: err.message });
        }

        if (!req.file) return res.status(400).json({ error: 'Ebook file required.' });
        
        const { title, author, subject_area, is_public } = req.body;
        const relativeFilePath = path.join(MEDIA_UPLOAD_DIR, req.file.filename);
        const visibility = is_public === 'true' ? 'Public' : 'Private';

        if (!title) return res.status(400).json({ error: 'Missing Ebook title.' });

        try {
            const result = await pool.query(
                `INSERT INTO media (user_id, title, description, file_path, media_type, access_level, upload_date, author, subject_area)
                 VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7, $8)
                 RETURNING id`,
                [req.user.id, title, author, relativeFilePath, 'Ebook', visibility, author, subject_area]
            );

            res.status(201).json({ 
                message: 'Ebook uploaded and cataloged successfully.', 
                mediaId: result.rows[0].id 
            });

        } catch (dbErr) {
            console.error('Database error saving ebook metadata:', dbErr);
            try { await fs.unlink(req.file.path); } catch(e) { console.error('Failed to delete file after DB error:', e); }
            res.status(500).json({ error: 'Failed to record Ebook in database.', details: dbErr.message });
        }
    });
});


/**
 * @route   GET /api/media/ebooks/public
 * @desc    Fetch all public ebooks (for student/staff view).
 * @access  Private (All authenticated users)
 */
router.get('/ebooks/public', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT id, title, author, subject_area, file_path, upload_date, media_type
            FROM media
            WHERE media_type = 'Ebook' AND access_level = 'Public'
            ORDER BY title ASC;
        `);
        res.status(200).json(result.rows); 
    } catch (err) {
        console.error('Error fetching public ebooks:', err);
        res.status(500).json({ error: 'Server error fetching public ebooks' });
    }
});

/**
 * @route   GET /api/media/ebooks/all
 * @desc    Fetch all ebooks (for admin/librarian management view).
 * @access  Private (Admin, Librarian)
 */
router.get('/ebooks/all', authenticateToken, authorize(UPLOAD_ROLES), async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT id, title, author, subject_area, file_path, upload_date, access_level AS is_public, media_type, created_at
            FROM media
            WHERE media_type = 'Ebook'
            ORDER BY created_at DESC;
        `);
        // Rename access_level to is_public for frontend compatibility
        const rows = result.rows.map(row => ({
            ...row,
            is_public: row.is_public === 'Public'
        }));

        res.status(200).json(rows); 
    } catch (err) {
        console.error('Error fetching all ebooks for catalog:', err);
        res.status(500).json({ error: 'Server error fetching ebook catalog' });
    }
});

/**
 * @route   DELETE /api/media/ebooks/:resourceId
 * @desc    Delete a specific ebook resource.
 * @access  Private (Admin, Librarian, Super Admin)
 */
router.delete('/ebooks/:resourceId', authenticateToken, authorize(UPLOAD_ROLES), async (req, res) => {
    const { resourceId } = req.params;
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');
        
        // 1. Retrieve file path for deletion
        const fileRes = await client.query(`SELECT file_path FROM media WHERE id = $1::uuid`, [resourceId]);
        if (fileRes.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Resource not found.' });
        }
        const relativeFilePath = fileRes.rows[0].file_path;
        const fullFilePath = path.join(__dirname, '..', 'uploads', relativeFilePath);

        // 2. Delete metadata from DB
        const result = await client.query(`DELETE FROM media WHERE id = $1::uuid RETURNING id`, [resourceId]);
        
        if (result.rowCount > 0) {
            // 3. Delete physical file (Ignore if file does not exist)
            await fs.unlink(fullFilePath).catch(e => {
                if (e.code !== 'ENOENT') { // ENOENT means "File not found"
                    console.error(`Failed to delete physical file ${fullFilePath}:`, e);
                }
            });
        }
        
        await client.query('COMMIT');
        res.status(200).json({ message: 'Resource deleted successfully.' });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Ebook Deletion Error:', err);
        res.status(500).json({ error: 'Failed to delete resource.' });
    } finally {
        client.release();
    }
});

module.exports = router;