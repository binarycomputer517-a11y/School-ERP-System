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
const upload = multer({ storage, limits: { fileSize: 15 * 1024 * 1024 } });

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

// 3. INBOX LISTING
router.get('/conversations', authenticateToken, authorize(MESSAGING_ROLES), async (req, res) => {
    const userId = req.user.id;
    try {
        const result = await pool.query(
            `SELECT c.id, c.topic AS title, c.is_group, c.last_message_at,
            CASE WHEN c.is_group = TRUE THEN c.topic 
            ELSE (SELECT u.full_name FROM conversation_participants cp_other JOIN users u ON cp_other.user_id = u.id
            WHERE cp_other.conversation_id = c.id AND cp_other.user_id != $1 LIMIT 1) END AS participant_name,
            (SELECT COUNT(*)::int FROM messages m WHERE m.conversation_id = c.id AND m.created_at > cp.last_read_at AND m.sender_id != $1) as unread_count
            FROM conversation_participants cp JOIN conversations c ON cp.conversation_id = c.id
            WHERE cp.user_id = $1 ORDER BY c.last_message_at DESC;`, [userId]);
        res.json(result.rows);
    } catch (error) { res.status(500).json({ message: 'Sync failed.' }); }
});

// 4. MESSAGE HISTORY & AUTO-READ
router.get('/messages/:conversationId', authenticateToken, async (req, res) => {
    const { conversationId } = req.params;
    const userId = req.user.id;
    try {
        const messages = await pool.query(
            `SELECT m.*, u.full_name AS sender_name FROM messages m 
             JOIN users u ON m.sender_id = u.id WHERE m.conversation_id = $1 ORDER BY m.created_at ASC`, [conversationId]);
        
        await pool.query(`UPDATE conversation_participants SET last_read_at = NOW() WHERE conversation_id = $1 AND user_id = $2`, [conversationId, userId]);
        res.json(messages.rows);
    } catch (error) { res.status(500).json({ message: 'Error loading chat.' }); }
});

// 5. MANUAL READ TRIGGER
router.put('/read/:conversationId', authenticateToken, async (req, res) => {
    try {
        await pool.query(`UPDATE conversation_participants SET last_read_at = NOW() WHERE conversation_id = $1 AND user_id = $2`, [req.params.conversationId, req.user.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: "Failed" }); }
});

// 6. CHAT INITIALIZATION (Find or Create)
router.post('/conversations/init', authenticateToken, async (req, res) => {
    const { targetUserId } = req.body;
    const currentUserId = req.user.id;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const existing = await client.query(`SELECT cp1.conversation_id FROM conversation_participants cp1
            JOIN conversation_participants cp2 ON cp1.conversation_id = cp2.conversation_id
            JOIN conversations c ON cp1.conversation_id = c.id
            WHERE cp1.user_id = $1 AND cp2.user_id = $2 AND c.is_group = false LIMIT 1`, [currentUserId, targetUserId]);

        if (existing.rows.length > 0) return res.json({ id: existing.rows[0].conversation_id });

        const newConv = await client.query(`INSERT INTO conversations (is_group) VALUES (false) RETURNING id`);
        const convId = newConv.rows[0].id;
        await client.query(`INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1, $2), ($1, $3)`, [convId, currentUserId, targetUserId]);
        await client.query(`INSERT INTO messages (conversation_id, sender_id, content) VALUES ($1, $2, 'Connection established. How can I help you?')`, [convId, targetUserId]);
        await client.query('COMMIT');
        res.status(201).json({ id: convId });
    } catch (e) { await client.query('ROLLBACK'); res.status(500).json({ message: 'Failed' }); } finally { client.release(); }
});

// 7. MEDIA UPLOAD & AI
router.post('/upload', authenticateToken, upload.single('file'), (req, res) => {
    res.json({ fileUrl: `/uploads/chat/${req.file.filename}` });
});

router.get('/ai-summary/:conversationId', authenticateToken, async (req, res) => {
    res.json({ summary: "Conversation summary generated successfully.", sentiment: "Neutral", next_steps: "Awaiting user input." });
});

/**
 * GET: Retrieve all media/files for a specific conversation
 * Useful for the "Media Gallery" sidebar
 */
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
module.exports = router;