// routes/media.js
const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken, authorize } = require('../authMiddleware'); 
const path = require('path');

// Assuming your main server.js attaches the configured Multer instance to the app object
// We can retrieve it inside the route handler or directly from the app object if passed correctly.
// A common approach is to import the specific middleware instance.
// For this example, we assume Multer is imported and configured for 'media'.
// NOTE: You must have a Multer configuration that saves files to the correct location (e.g., /uploads/media).

// Define the directory name for media uploads relative to /uploads
const MEDIA_UPLOAD_DIR = 'media';

// --- Helper function to get Multer instance ---
// Since Multer is often instantiated with configuration, 
// we'll assume a basic single-file upload instance is available via req.app.get('upload').single('file')
function getMediaUploader(req) {
    // Get the base Multer instance configured in server.js
    const baseMulter = req.app.get('upload');
    // Configure it for a single field named 'file'
    return baseMulter.single('file');
}

// ===========================================
// 1. GET Route: Fetch Media Gallery Items
// ===========================================

router.get('/', authenticateToken, async (req, res) => {
    try {
        // Query the media table for items that the user is authorized to see
        const result = await pool.query(`
            SELECT 
                id, 
                title, 
                media_type, 
                file_path, 
                upload_date,
                access_level
            FROM media
            WHERE access_level = 'Public' -- Basic public filter
            ORDER BY upload_date DESC;
        `);

        res.status(200).json(result.rows); 
    } catch (err) {
        console.error('Error fetching media gallery:', err);
        res.status(500).json({ error: 'Server error fetching media', details: err.message });
    }
});


// ===========================================
// 2. POST Route: Handle Media Upload
// ===========================================

// Route: POST /api/media/upload
router.post('/upload', authenticateToken, authorize('Admin', 'Teacher'), async (req, res) => {
    // Execute Multer middleware. 'file' is the field name from upload-media.html
    const upload = getMediaUploader(req);

    upload(req, res, async function (err) {
        if (err) {
            // Handle Multer errors (e.g., file size limit, wrong file type)
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(400).json({ error: 'File size limit exceeded (max 50MB).' });
            }
            console.error('Multer upload error:', err);
            return res.status(500).json({ error: 'File upload failed.', details: err.message });
        }

        // Check if a file was successfully uploaded
        if (!req.file) {
            return res.status(400).json({ error: 'No file selected for upload.' });
        }
        
        // Extract form fields and file path
        const { title, description, media_type, access_level } = req.body;
        
        // The file path relative to the /uploads directory
        // Example: If Multer saves to /uploads/media, the file_path is stored relative to that.
        // We assume the Multer config stores the file object property 'filename' or 'path' in req.file
        // For security, we'll construct the path to ensure it starts with our media directory
        const relativeFilePath = path.join(MEDIA_UPLOAD_DIR, req.file.filename);
        
        // Ensure required data is present
        if (!title || !media_type) {
            return res.status(400).json({ error: 'Missing required fields: Title and Media Type.' });
        }

        try {
            // Save the media metadata to the database
            const result = await pool.query(
                `INSERT INTO media (user_id, title, description, file_path, media_type, access_level, upload_date)
                 VALUES ($1, $2, $3, $4, $5, $6, NOW())
                 RETURNING id`,
                [req.user.id, title, description, relativeFilePath, media_type, access_level]
            );

            res.status(201).json({ 
                message: 'Media uploaded successfully.', 
                mediaId: result.rows[0].id 
            });

        } catch (dbErr) {
            console.error('Database error saving media metadata:', dbErr);
            // In a real application, you should delete the uploaded file here if the DB insert fails.
            res.status(500).json({ error: 'Failed to record media in database.', details: dbErr.message });
        }
    });
});

module.exports = router;