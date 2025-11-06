// routes/messaging.js

const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken, authorize } = require('../authMiddleware'); 
const moment = require('moment');

// Database Table Constants
const CONVERSATIONS_TABLE = 'conversations';
const PARTICIPANTS_TABLE = 'conversation_participants';
const MESSAGES_TABLE = 'messages';
const USERS_TABLE = 'users';
const MESSAGE_STATUS_TABLE = 'message_status'; 

// =========================================================
// 1. CONVERSATION MANAGEMENT & CREATION
// =========================================================

/**
 * @route   GET /api/messaging/conversations
 * @desc    Get all conversations for the logged-in user.
 * @access  Private (ALL authenticated users)
 */
router.get('/conversations', authenticateToken, async (req, res) => {
    const userId = req.user.userId;

    try {
        const query = `
            SELECT 
                c.id, c.is_group, c.topic, c.last_message_at,
                (SELECT string_agg(u.username, ', ') 
                 FROM ${PARTICIPANTS_TABLE} cp 
                 JOIN ${USERS_TABLE} u ON cp.user_id = u.id
                 WHERE cp.conversation_id = c.id AND cp.user_id != $1) AS participants_names
            FROM ${CONVERSATIONS_TABLE} c
            JOIN ${PARTICIPANTS_TABLE} p ON c.id = p.conversation_id
            WHERE p.user_id = $1
            ORDER BY c.last_message_at DESC;
        `;
        const result = await pool.query(query, [userId]);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching conversations:', error);
        res.status(500).json({ message: 'Failed to retrieve conversations.' });
    }
});

/**
 * @route   POST /api/messaging/conversations
 * @desc    Create a new private or group conversation.
 * @access  Private (ALL authenticated users)
 */
router.post('/conversations', authenticateToken, async (req, res) => {
    const creatorId = req.user.userId;
    const { participant_ids, topic } = req.body; 

    // VALIDATION CHECK
    if (!creatorId || typeof creatorId !== 'string' || creatorId.length < 30) {
        return res.status(401).json({ message: 'Unauthorized: Missing or invalid user ID from token.' });
    }
    
    if (!participant_ids || participant_ids.length === 0) {
        return res.status(400).json({ message: 'Missing participants.' });
    }
    
    const uniqueParticipants = Array.from(new Set([...participant_ids, creatorId]));
    const isGroup = uniqueParticipants.length > 2;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        // CRITICAL FIX: Validate all participant IDs exist in the users table
        const userCheckQuery = `
            SELECT id FROM ${USERS_TABLE} 
            WHERE id = ANY($1::UUID[])
        `;
        const userCheckResult = await client.query(userCheckQuery, [uniqueParticipants]);
        
        if (userCheckResult.rows.length !== uniqueParticipants.length) {
            await client.query('ROLLBACK');
            // This error message is clearer for the frontend than a generic 500
            return res.status(400).json({ message: 'Error: One or more participant IDs are invalid or non-existent.' });
        }


        // 1. Create Conversation
        const convoQuery = `
            INSERT INTO ${CONVERSATIONS_TABLE} (is_group, topic, created_by_id)
            VALUES ($1, $2, $3)
            RETURNING id;
        `;
        const convoResult = await client.query(convoQuery, [
            isGroup, topic || (isGroup ? 'Group Chat' : null), creatorId
        ]);
        const conversationId = convoResult.rows[0].id;

        // 2. Add Participants (Using parameterized queries for security)
        const participantTuples = uniqueParticipants.map(id => {
            const isActive = true; 
            const isAdmin = isGroup && id === creatorId;
            return [conversationId, id, isActive, isAdmin]; 
        });

        const flatParticipantData = participantTuples.flat();
        const tupleCount = participantTuples.length;
        const valuePlaceholders = Array.from({ length: tupleCount }, (_, i) => 
            `($${i * 4 + 1}, $${i * 4 + 2}, $${i * 4 + 3}, $${i * 4 + 4})`
        ).join(',');

        await client.query(`
            INSERT INTO ${PARTICIPANTS_TABLE} (conversation_id, user_id, is_active, is_admin)
            VALUES ${valuePlaceholders};
        `, flatParticipantData);
        
        await client.query('COMMIT');
        res.status(201).json({ message: 'Conversation created.', conversation_id: conversationId });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Conversation Creation Error:', error);
        // Fallback for unexpected errors (e.g., DB connection loss)
        res.status(500).json({ message: 'Failed to create conversation.' });
    } finally {
        client.release();
    }
});

/**
 * @route   POST /api/messaging/conversations/:conversationId/read
 * @desc    Marks all unread messages as 'read'.
 * @access  Private (ALL authenticated users)
 */
router.post('/conversations/:conversationId/read', authenticateToken, async (req, res) => {
    const { conversationId } = req.params;
    const readerId = req.user.userId;
    const now = new Date();

    try {
        const participantCheck = await pool.query(`SELECT id FROM ${PARTICIPANTS_TABLE} WHERE conversation_id = $1 AND user_id = $2`, [conversationId, readerId]);
        if (participantCheck.rowCount === 0) {
            return res.status(403).json({ message: 'Access denied to this conversation.' });
        }
        
        // Inserts records into the message_status table for all unread messages
        await pool.query(`
            INSERT INTO ${MESSAGE_STATUS_TABLE} (message_id, user_id, read_at)
            SELECT 
                m.id, $1, $2
            FROM ${MESSAGES_TABLE} m
            WHERE m.conversation_id = $3
            AND m.sender_id != $1 
            AND NOT EXISTS (
                SELECT 1 FROM ${MESSAGE_STATUS_TABLE} ms
                WHERE ms.message_id = m.id AND ms.user_id = $1
            )
            ON CONFLICT (message_id, user_id) DO NOTHING;
        `, [readerId, now, conversationId]);

        res.status(200).json({ message: 'Messages marked as read.' });

    } catch (error) {
        console.error('Error marking messages as read:', error);
        res.status(500).json({ message: 'Failed to update read status.' });
    }
});

/**
 * @route   GET /api/messaging/users/search
 * @desc    Search for users by username or part of ID.
 * @access  Private (ALL authenticated users)
 */
router.get('/users/search', authenticateToken, async (req, res) => {
    const currentUserId = req.user.userId;
    const searchTerm = req.query.query;

    if (!searchTerm || searchTerm.length < 2) {
        return res.status(200).json([]);
    }

    try {
        // IMPROVED SEARCH LOGIC: Search by username OR by the first 8 characters of the ID.
        // This is necessary because many usernames are just numbers ('1', '2', '500') 
        // and full_name is often NULL.
        const searchQuery = `
            SELECT 
                id, 
                username
            FROM ${USERS_TABLE}
            WHERE 
                id != $1 AND 
                (username ILIKE $2 OR SUBSTRING(id::text, 1, 8) ILIKE $3)
            ORDER BY username ASC 
            LIMIT 10;
        `;
        // Prepare search terms
        const usernameSearch = `%${searchTerm}%`;
        const idSearch = `${searchTerm}%`; // Use prefix match for ID substring
        
        const result = await pool.query(searchQuery, [currentUserId, usernameSearch, idSearch]);
        
        res.status(200).json(result.rows.map(row => ({
            id: row.id,
            // Use username as the primary display name
            name: row.username, 
            value: `${row.username} [ID: ${row.id.substring(0, 8)}...]`
        })));
        
    } catch (error) {
        console.error('Error searching users:', error);
        res.status(500).json({ message: 'Failed to search users.' });
    }
});


// =========================================================
// 2. MESSAGING (GET/POST)
// =========================================================

/**
 * @route   GET /api/messaging/messages/:conversationId
 * @desc    Get messages for a specific conversation.
 * @access  Private (ALL authenticated users)
 */
router.get('/messages/:conversationId', authenticateToken, async (req, res) => {
    const { conversationId } = req.params;
    const userId = req.user.userId;

    try {
        // 1. Verify user is a participant
        const participantCheck = await pool.query(`SELECT id FROM ${PARTICIPANTS_TABLE} WHERE conversation_id = $1 AND user_id = $2`, [conversationId, userId]);
        if (participantCheck.rowCount === 0) {
            return res.status(403).json({ message: 'Access denied to this conversation.' });
        }

        // 2. Fetch messages
        const messagesQuery = `
            SELECT 
                m.id, 
                CASE WHEN m.deleted_at IS NOT NULL THEN '[Message Deleted]' ELSE m.content END AS content,
                m.created_at, m.sender_id, m.is_edited, m.deleted_at, 
                u.username AS sender_name,
                COUNT(ms.user_id) FILTER (WHERE ms.read_at IS NOT NULL) AS read_count 
            FROM ${MESSAGES_TABLE} m
            JOIN ${USERS_TABLE} u ON m.sender_id = u.id
            LEFT JOIN ${MESSAGE_STATUS_TABLE} ms ON m.id = ms.message_id
            WHERE m.conversation_id = $1
            GROUP BY m.id, u.username, m.content, m.created_at, m.sender_id, m.is_edited, m.deleted_at
            ORDER BY m.created_at ASC;
        `;
        const result = await pool.query(messagesQuery, [conversationId]);
        
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching messages:', error);
        res.status(500).json({ message: 'Failed to retrieve messages.' });
    }
});

/**
 * @route   POST /api/messaging/messages/:conversationId
 * @desc    Send a new message to a conversation.
 * @access  Private (ALL authenticated users)
 */
router.post('/messages/:conversationId', authenticateToken, async (req, res) => {
    const { conversationId } = req.params;
    const senderId = req.user.userId;
    const { content } = req.body;

    if (!content) {
        return res.status(400).json({ message: 'Message content cannot be empty.' });
    }
    
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        // 1. Verify user is a participant
        const participantCheck = await client.query(`SELECT id FROM ${PARTICIPANTS_TABLE} WHERE conversation_id = $1 AND user_id = $2`, [conversationId, senderId]);
        if (participantCheck.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(403).json({ message: 'Not a participant in this conversation.' });
        }
        
        // 2. Insert Message
        const messageQuery = `
            INSERT INTO ${MESSAGES_TABLE} (conversation_id, sender_id, content)
            VALUES ($1, $2, $3)
            RETURNING id, created_at;
        `;
        const messageResult = await client.query(messageQuery, [conversationId, senderId, content]);
        
        // 3. Update Conversation's last_message_at timestamp
        await client.query(`UPDATE ${CONVERSATIONS_TABLE} SET last_message_at = CURRENT_TIMESTAMP WHERE id = $1`, [conversationId]);
        
        await client.query('COMMIT');
        res.status(201).json({ message: 'Message sent.', message_id: messageResult.rows[0].id, created_at: messageResult.rows[0].created_at });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error sending message:', error);
        res.status(500).json({ message: 'Failed to send message.' });
    } finally {
        client.release();
    }
});

// =========================================================
// 3. MESSAGE EDIT/DELETE
// =========================================================

/**
 * @route   PUT /api/messaging/messages/:messageId
 * @desc    Edit the content of an existing message.
 * @access  Private (ALL authenticated users)
 */
router.put('/messages/:messageId', authenticateToken, async (req, res) => {
    const { messageId } = req.params;
    const senderId = req.user.userId;
    const { newContent } = req.body;

    if (!newContent || newContent.trim() === '') {
        return res.status(400).json({ message: 'New message content cannot be empty.' });
    }
    
    try {
        const result = await pool.query(`
            UPDATE ${MESSAGES_TABLE}
            SET content = $1, is_edited = TRUE
            WHERE id = $2 AND sender_id = $3 AND deleted_at IS NULL
            RETURNING id;
        `, [newContent, messageId, senderId]);

        if (result.rowCount === 0) {
            return res.status(403).json({ message: 'Message not found, user is not the sender, or message is deleted.' });
        }

        res.status(200).json({ message: 'Message updated successfully.', message_id: messageId });
    } catch (error) {
        console.error('Error editing message:', error);
        res.status(500).json({ message: 'Failed to edit message.' });
    }
});

/**
 * @route   DELETE /api/messaging/messages/:messageId
 * @desc    Soft-delete a message (sets deleted_at timestamp).
 * @access  Private (ALL authenticated users)
 */
router.delete('/messages/:messageId', authenticateToken, async (req, res) => {
    const { messageId } = req.params;
    const senderId = req.user.userId;

    try {
        const result = await pool.query(`
            UPDATE ${MESSAGES_TABLE}
            SET deleted_at = CURRENT_TIMESTAMP, content = '[This message was deleted]', is_edited = FALSE
            WHERE id = $1 AND sender_id = $2 AND deleted_at IS NULL
            RETURNING id;
        `, [messageId, senderId]);

        if (result.rowCount === 0) {
            return res.status(403).json({ message: 'Message not found, user is not the sender, or message already deleted.' });
        }
        
        res.status(200).json({ message: 'Message soft-deleted successfully.' });
    } catch (error) {
        console.error('Error deleting message:', error);
        res.status(500).json({ message: 'Failed to delete message.' });
    }
});

module.exports = router;