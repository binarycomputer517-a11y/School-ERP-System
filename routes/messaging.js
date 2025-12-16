// routes/messaging.js (FINAL & COMPLETE VERSION)

const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken, authorize } = require('../authMiddleware'); 

const MESSAGING_ROLES = ['Super Admin', 'Admin', 'Teacher', 'Coordinator', 'Student', 'Parent']; 

// =========================================================
// 1. GET Conversation List (Fixed for Many-to-Many Schema)
// =========================================================
/**
 * @route   GET /api/messaging/conversations
 * @desc    Fetches all conversations for the currently logged-in user.
 * @access  Private
 */
router.get('/conversations', authenticateToken, authorize(MESSAGING_ROLES), async (req, res) => {
    const userId = req.user.id; 

    if (!userId) {
        return res.status(401).json({ message: 'User ID missing in token.' });
    }

    try {
        // This query finds all conversations a user is part of and determines the display name
        const result = await pool.query(
            `
            SELECT 
                c.id, 
                c.topic AS title,
                c.is_group,
                c.last_message_at,
                -- Determine the display name: Use the topic for group chats, otherwise find the other user's name.
                CASE
                    WHEN c.is_group = TRUE THEN c.topic 
                    ELSE (
                        SELECT u.full_name
                        FROM conversation_participants cp_other
                        JOIN users u ON cp_other.user_id = u.id
                        WHERE cp_other.conversation_id = c.id
                          AND cp_other.user_id != $1 -- Find the ID that is NOT the current user
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
        res.status(500).json({ message: 'Failed to retrieve conversations due to DB error.', error: error.message });
    }
});

// =========================================================
// 2. POST New Conversation
// =========================================================
/**
 * @route   POST /api/messaging/conversations/new
 * @desc    Creates a new conversation session.
 * @access  Private (Usually initiated by Admin/Staff/Teacher)
 */
router.post('/conversations/new', authenticateToken, authorize(MESSAGING_ROLES), async (req, res) => {
    const { participants, topic, is_group } = req.body;
    const createdById = req.user.id; 

    if (!participants || !Array.isArray(participants) || participants.length < 2) {
        return res.status(400).json({ message: 'Participants list is required and must contain at least two users.' });
    }

    // 1. Check for existing 1-to-1 conversation if it's not a group
    if (!is_group) {
        const otherUserId = participants.find(id => id !== createdById);
        try {
            const existingConversation = await pool.query(
                `
                SELECT c.id, c.topic, u.full_name AS participant_name
                FROM conversations c
                JOIN conversation_participants cp1 ON c.id = cp1.conversation_id
                JOIN conversation_participants cp2 ON c.id = cp2.conversation_id
                JOIN users u ON u.id = $2
                WHERE c.is_group = FALSE
                  AND cp1.user_id = $1
                  AND cp2.user_id = $2
                LIMIT 1;
                `,
                [createdById, otherUserId]
            );

            if (existingConversation.rowCount > 0) {
                // If chat exists, return existing details
                return res.status(200).json(existingConversation.rows[0]);
            }
        } catch (e) {
            console.error('Error checking for existing conversation:', e);
            // Continue if there's an error
        }
    }

    // 2. Begin Transaction to create new conversation and add participants
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // A. Insert into conversations table
        const conversationTopic = topic || null;
        const newConvResult = await client.query(
            `INSERT INTO conversations (is_group, topic, created_by_id) 
             VALUES ($1, $2, $3) RETURNING id, topic;`,
            [is_group, conversationTopic, createdById]
        );
        const newConversationId = newConvResult.rows[0].id;
        const newConversationTopic = newConvResult.rows[0].topic;

        // B. Insert all participants into conversation_participants table
        // We use map and join to safely inject multiple rows of data
        const participantValues = participants.map(id => `('${newConversationId}', '${id}', ${id === createdById ? 'TRUE' : 'FALSE'})`).join(', ');
        
        await client.query(
            `INSERT INTO conversation_participants (conversation_id, user_id, is_admin) 
             VALUES ${participantValues};`
        );

        await client.query('COMMIT');

        // C. Prepare and send the response
        let participantName = newConversationTopic;
        if (!is_group) {
            const otherUser = await pool.query('SELECT full_name FROM users WHERE id = $1', [participants.find(id => id !== createdById)]);
            participantName = otherUser.rows[0]?.full_name || 'New Chat';
        }

        res.status(201).json({ 
            id: newConversationId, 
            topic: newConversationTopic, 
            participant_name: participantName,
            is_group: is_group
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Transaction Error creating conversation:', error);
        res.status(500).json({ message: 'Failed to create new conversation.', error: error.message });
    } finally {
        client.release();
    }
});


// =========================================================
// 3. GET Message History
// =========================================================
/**
 * @route   GET /api/messaging/messages/:conversationId
 * @desc    Fetches messages for a specific conversation.
 * @access  Private
 */
router.get('/messages/:conversationId', authenticateToken, authorize(MESSAGING_ROLES), async (req, res) => {
    const { conversationId } = req.params;
    const userId = req.user.id; 

    try {
        // 1. Verify the user is a participant
        const participationCheck = await pool.query(
            'SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2',
            [conversationId, userId]
        );

        if (participationCheck.rowCount === 0) {
            return res.status(403).json({ message: 'Access denied to this conversation.' });
        }

        // 2. Fetch messages
        const messages = await pool.query(
            `
            SELECT 
                m.sender_id, 
                m.content, 
                m.created_at AS timestamp,
                u.full_name AS sender_name
            FROM messages m
            JOIN users u ON m.sender_id = u.id
            WHERE m.conversation_id = $1
            ORDER BY m.created_at ASC
            `,
            [conversationId]
        );

        res.status(200).json(messages.rows);
    } catch (error) {
        console.error('DB Error fetching messages:', error);
        res.status(500).json({ message: 'Failed to retrieve messages.' });
    }
});


module.exports = router;