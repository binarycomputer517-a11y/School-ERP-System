// routes/messaging.js (ULTRA-PREMIUM ENTERPRISE VERSION)

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { pool } = require('../database');
const { authenticateToken, authorize } = require('../authMiddleware'); 

const MESSAGING_ROLES = ['Super Admin', 'Admin', 'Teacher', 'Coordinator', 'Student', 'Parent']; 

// --- Multer Setup for Voice/Image Uploads ---
const uploadDir = 'uploads/chat';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, cb) => {
        cb(null, `CHAT-${Date.now()}${path.extname(file.originalname)}`);
    }
});
const upload = multer({ storage });

// =========================================================
// 1. GET Conversation List (With Participant Info)
// =========================================================
router.get('/conversations', authenticateToken, authorize(MESSAGING_ROLES), async (req, res) => {
    const userId = req.user.id; 

    try {
        const result = await pool.query(
            `
            SELECT 
                c.id, 
                c.topic AS title,
                c.is_group,
                c.last_message_at,
                CASE
                    WHEN c.is_group = TRUE THEN c.topic 
                    ELSE (
                        SELECT u.full_name
                        FROM conversation_participants cp_other
                        JOIN users u ON cp_other.user_id = u.id
                        WHERE cp_other.conversation_id = c.id
                          AND cp_other.user_id != $1
                        LIMIT 1
                    )
                END AS participant_name
            FROM conversation_participants cp
            JOIN conversations c ON cp.conversation_id = c.id
            WHERE cp.user_id = $1
            ORDER BY c.last_message_at DESC;
            `,
            [userId]
        );
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('DB Error fetching conversations:', error);
        res.status(500).json({ message: 'Failed to retrieve conversations.' });
    }
});

// =========================================================
// 2. POST New Conversation
// =========================================================
router.post('/conversations/new', authenticateToken, authorize(MESSAGING_ROLES), async (req, res) => {
    const { participants, topic, is_group } = req.body;
    const createdById = req.user.id; 

    if (!participants || !Array.isArray(participants) || participants.length < 2) {
        return res.status(400).json({ message: 'Minimum 2 participants required.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Create Header
        const newConv = await client.query(
            `INSERT INTO conversations (is_group, topic, created_by_id) VALUES ($1, $2, $3) RETURNING id, topic;`,
            [is_group || false, topic || null, createdById]
        );
        const conversationId = newConv.rows[0].id;

        // Insert Participants
        for (const uid of participants) {
            await client.query(
                `INSERT INTO conversation_participants (conversation_id, user_id, is_admin) VALUES ($1, $2, $3);`,
                [conversationId, uid, uid === createdById]
            );
        }

        await client.query('COMMIT');
        res.status(201).json({ id: conversationId, topic: newConv.rows[0].topic });
    } catch (error) {
        await client.query('ROLLBACK');
        res.status(500).json({ message: 'Transaction failed.' });
    } finally {
        client.release();
    }
});

// =========================================================
// 3. GET Message History (Including message_type & file_url)
// =========================================================
router.get('/messages/:conversationId', authenticateToken, authorize(MESSAGING_ROLES), async (req, res) => {
    const { conversationId } = req.params;
    const userId = req.user.id; 

    try {
        const messages = await pool.query(
            `
            SELECT 
                m.sender_id, 
                m.content, 
                m.message_type, 
                m.file_url,
                m.created_at AS timestamp,
                u.full_name AS sender_name
            FROM messages m
            JOIN users u ON m.sender_id = u.id
            WHERE m.conversation_id = $1
            ORDER BY m.created_at ASC
            `,
            [conversationId]
        );

        // Update last_read_at when opening chat
        await pool.query(
            `UPDATE conversation_participants SET last_read_at = CURRENT_TIMESTAMP 
             WHERE conversation_id = $1 AND user_id = $2`,
            [conversationId, userId]
        );

        res.status(200).json(messages.rows);
    } catch (error) {
        res.status(500).json({ message: 'Failed to retrieve messages.' });
    }
});

// =========================================================
// 4. GET Unread Count (Dynamic Badge)
// =========================================================
router.get('/unread-count', authenticateToken, authorize(MESSAGING_ROLES), async (req, res) => {
    const userId = req.user.id;
    try {
        const result = await pool.query(
            `
            SELECT COUNT(*)::int AS unread_total
            FROM messages m
            JOIN conversation_participants cp ON m.conversation_id = cp.conversation_id
            WHERE cp.user_id = $1
              AND m.sender_id != $1
              AND m.created_at > cp.last_read_at;
            `,
            [userId]
        );
        res.status(200).json({ count: result.rows[0].unread_total });
    } catch (error) {
        res.status(500).json({ count: 0 });
    }
});

// =========================================================
// 5. UPDATE Read Status (Explicit Trigger)
// =========================================================
router.put('/read/:conversationId', authenticateToken, authorize(MESSAGING_ROLES), async (req, res) => {
    try {
        await pool.query(
            `UPDATE conversation_participants SET last_read_at = CURRENT_TIMESTAMP 
             WHERE conversation_id = $1 AND user_id = $2`,
            [req.params.conversationId, req.user.id]
        );
        res.status(200).json({ message: 'Marked as read' });
    } catch (e) { res.status(500).json({ message: 'Error' }); }
});

// =========================================================
// 6. UPLOAD Chat Media (Voice Message/Images)
// =========================================================
router.post('/upload', authenticateToken, upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ message: 'Upload failed' });
    res.json({ fileUrl: `/uploads/chat/${req.file.filename}` });
});

module.exports = router;