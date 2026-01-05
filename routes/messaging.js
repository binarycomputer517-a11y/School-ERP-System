const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { pool } = require('../database');
const { authenticateToken, authorize } = require('../authMiddleware');

const MESSAGING_ROLES = ['Super Admin', 'Admin', 'Teacher', 'Coordinator', 'Student', 'Parent'];

// 1. SECURE STORAGE CONFIG
const uploadDir = path.join(__dirname, '../uploads/chat');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        cb(null, `CHAT-${Date.now()}${path.extname(file.originalname)}`);
    }
});

// File filter for security
const fileFilter = (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|mp3|webm|wav|ogg|pdf|doc|docx/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    if (extname && mimetype) return cb(null, true);
    cb(new Error('Error: File type not supported!'));
};

const upload = multer({ 
    storage, 
    fileFilter,
    limits: { fileSize: 15 * 1024 * 1024 } // 15MB Limit
});

// 2. GLOBAL UNREAD COUNT (For Dashboard Badges)
router.get('/unread-count', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT COUNT(*)::int AS count FROM messages m
             JOIN conversation_participants cp ON m.conversation_id = cp.conversation_id
             WHERE cp.user_id = $1 AND m.sender_id != $1 AND m.created_at > cp.last_read_at`,
            [req.user.id]
        );
        res.json(result.rows[0]);
    } catch (e) { res.json({ count: 0 }); }
});

// 3. INBOX LISTING (With Dynamic Profile Photo & Last Seen)
router.get('/conversations', authenticateToken, authorize(MESSAGING_ROLES), async (req, res) => {
    const userId = req.user.id;
    try {
        const result = await pool.query(
            `SELECT 
                c.id, 
                c.is_group, 
                c.last_message_at,
                other_u.id as participant_id,
                CASE 
                    WHEN c.is_group = TRUE THEN c.topic 
                    ELSE COALESCE(other_u.full_name, other_u.username, 'User') 
                END AS participant_name,
                CASE 
                    WHEN c.is_group = TRUE THEN NULL
                    WHEN other_u.role = 'Student' THEN (SELECT profile_image_path FROM students WHERE user_id = other_u.id LIMIT 1)
                    WHEN other_u.role = 'Teacher' THEN (SELECT profile_image_path FROM teachers WHERE user_id = other_u.id LIMIT 1)
                    ELSE NULL 
                END AS participant_photo,
                (SELECT COUNT(*)::int FROM messages m 
                 WHERE m.conversation_id = c.id 
                 AND m.created_at > cp.last_read_at 
                 AND m.sender_id != $1) as unread_count
            FROM conversation_participants cp 
            JOIN conversations c ON cp.conversation_id = c.id
            LEFT JOIN conversation_participants cp_other ON c.id = cp_other.conversation_id AND cp_other.user_id != $1
            LEFT JOIN users other_u ON cp_other.user_id = other_u.id
            WHERE cp.user_id = $1 
            ORDER BY c.last_message_at DESC`, 
            [userId]
        );
        res.json(result.rows);
    } catch (error) { 
        console.error("Inbox Sync Error:", error);
        res.status(500).json({ message: 'Sync failed.' }); 
    }
});

// 4. MESSAGE HISTORY (With Reply Support)
router.get('/messages/:conversationId', authenticateToken, async (req, res) => {
    const { conversationId } = req.params;
    const userId = req.user.id;
    try {
        const messages = await pool.query(
            `SELECT m.*, u.full_name AS sender_name,
             rm.content as reply_to_content, ru.full_name as reply_to_sender
             FROM messages m 
             JOIN users u ON m.sender_id = u.id 
             LEFT JOIN messages rm ON m.reply_to_id = rm.id
             LEFT JOIN users ru ON rm.sender_id = ru.id
             WHERE m.conversation_id = $1 
             ORDER BY m.created_at ASC`, [conversationId]);
        
        await pool.query(
            `UPDATE conversation_participants 
             SET last_read_at = NOW() 
             WHERE conversation_id = $1 AND user_id = $2`, 
            [conversationId, userId]
        );
        res.json(messages.rows);
    } catch (error) { res.status(500).json({ message: 'Error loading chat.' }); }
});

// 5. MANUAL READ TRIGGER
router.put('/read/:conversationId', authenticateToken, async (req, res) => {
    try {
        await pool.query(
            `UPDATE conversation_participants 
             SET last_read_at = NOW() 
             WHERE conversation_id = $1 AND user_id = $2`, 
            [req.params.conversationId, req.user.id]
        );
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: "Failed" }); }
});

// 6. CHAT INITIALIZATION
router.post(['/conversations/init', '/conversations/new'], authenticateToken, async (req, res) => {
    const targetUserId = req.body.targetUserId || (req.body.recipient_ids ? req.body.recipient_ids[0] : null);
    const initialMessage = req.body.initial_message || 'Connection established.';
    const currentUserId = req.user.id;

    if (!targetUserId) return res.status(400).json({ message: 'Recipient required' });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        const existing = await client.query(`
            SELECT cp1.conversation_id FROM conversation_participants cp1
            JOIN conversation_participants cp2 ON cp1.conversation_id = cp2.conversation_id
            JOIN conversations c ON cp1.conversation_id = c.id
            WHERE cp1.user_id = $1 AND cp2.user_id = $2 AND c.is_group = false LIMIT 1`, 
            [currentUserId, targetUserId]
        );

        if (existing.rows.length > 0) {
            await client.query('COMMIT');
            return res.json({ id: existing.rows[0].conversation_id });
        }

        const newConv = await client.query(`INSERT INTO conversations (is_group, last_message_at) VALUES (false, NOW()) RETURNING id`);
        const convId = newConv.rows[0].id;
        
        await client.query(
            `INSERT INTO conversation_participants (conversation_id, user_id, last_read_at) 
             VALUES ($1, $2, NOW()), ($1, $3, '1970-01-01')`, 
            [convId, currentUserId, targetUserId]
        );
        
        await client.query(
            `INSERT INTO messages (conversation_id, sender_id, content) 
             VALUES ($1, $2, $3)`, 
            [convId, currentUserId, initialMessage]
        );
        
        await client.query('COMMIT');
        res.status(201).json({ id: convId });
    } catch (e) { 
        await client.query('ROLLBACK'); 
        res.status(500).json({ message: 'Failed to create conversation' }); 
    } finally { client.release(); }
});

// 7. USER STATUS (Last Seen Logic)
router.get('/user-status/:userId', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT last_seen, (NOW() - last_seen < INTERVAL '2 minutes') AS is_online 
             FROM users WHERE id = $1`, [req.params.userId]
        );
        res.json(result.rows[0] || { is_online: false, last_seen: null });
    } catch (e) { res.status(500).json({ error: "Status check failed" }); }
});

// 8. MEDIA UPLOAD & GALLERY
router.post('/upload', authenticateToken, upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });
    res.json({ 
        fileUrl: `/uploads/chat/${req.file.filename}`,
        message_type: req.file.mimetype.startsWith('image') ? 'image' : 'voice'
    });
});

router.get('/media/:conversationId', authenticateToken, async (req, res) => {
    const { conversationId } = req.params;
    try {
        const media = await pool.query(
            `SELECT file_url, message_type, created_at 
             FROM messages 
             WHERE conversation_id = $1 AND message_type IN ('image', 'voice', 'document')
             ORDER BY created_at DESC`,
            [conversationId]
        );
        res.json(media.rows);
    } catch (error) {
        res.status(500).json({ message: 'Error retrieving media gallery.' });
    }
});

// 9. DELETE FOR EVERYONE (Soft Delete Integration)
router.delete('/message/:messageId', authenticateToken, async (req, res) => {
    const { messageId } = req.params;
    const userId = req.user.id;
    try {
        const result = await pool.query(
            `UPDATE messages SET deleted_at = NOW(), content = 'This message was deleted' 
             WHERE id = $1 AND sender_id = $2 RETURNING conversation_id`,
            [messageId, userId]
        );

        if (result.rows.length === 0) {
            return res.status(403).json({ message: "Unauthorized or message not found." });
        }

        const io = req.app.get('io');
        if (io) io.to(result.rows[0].conversation_id).emit('message_deleted', messageId);

        res.json({ success: true, message: "Message deleted for everyone." });
    } catch (err) { res.status(500).json({ message: "Deletion failed." }); }
});

module.exports = router;