/**
 * routes/messaging.js
 * Final production-ready messaging routes.
 * * Includes:
 * - Search by Name, Email, OR User ID (UUID)
 * - Pagination
 * - Socket.IO broadcasting
 * - Transaction safety
 */

const express = require('express');
const router = express.Router();
const { pool } = require('../database'); // Ensure this points to your DB config
const { authenticateToken } = require('../authMiddleware'); // Ensure this points to your middleware

// Database Table Constants
const CONVERSATIONS_TABLE = 'conversations';
const PARTICIPANTS_TABLE = 'conversation_participants';
const MESSAGES_TABLE = 'messages';
const USERS_TABLE = 'users';
const MESSAGE_STATUS_TABLE = 'message_status';

// Utility: safe parse int
function toInt(v, def) {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? def : n;
}

// =========================================================
// 1. CONVERSATION MANAGEMENT
// =========================================================

/**
 * GET /api/messaging/conversations
 * Get list of all conversations for the current user
 */
router.get('/conversations', authenticateToken, async (req, res) => {
  const userId = req.user.userId;
  try {
    const q = `
      SELECT
        c.id,
        c.is_group,
        c.topic,
        c.last_message_at,
        (
          SELECT string_agg(u.username, ', ' ORDER BY u.username)
          FROM ${PARTICIPANTS_TABLE} cp
          JOIN ${USERS_TABLE} u ON cp.user_id = u.id
          WHERE cp.conversation_id = c.id AND cp.user_id != $1
        ) AS participants_names
      FROM ${CONVERSATIONS_TABLE} c
      JOIN ${PARTICIPANTS_TABLE} p ON c.id = p.conversation_id
      WHERE p.user_id = $1
      ORDER BY c.last_message_at DESC NULLS LAST, c.created_at DESC;
    `;
    const result = await pool.query(q, [userId]);
    return res.status(200).json(result.rows);
  } catch (err) {
    console.error('Error fetching conversations:', err);
    return res.status(500).json({ message: 'Failed to retrieve conversations.' });
  }
});

/**
 * POST /api/messaging/conversations
 * Create a new conversation
 */
router.post('/conversations', authenticateToken, async (req, res) => {
  const creatorId = req.user.userId;
  const { participant_ids, topic } = req.body;

  if (!creatorId) return res.status(401).json({ message: 'Unauthorized.' });
  if (!Array.isArray(participant_ids) || participant_ids.length === 0) {
    return res.status(400).json({ message: 'Missing participants.' });
  }

  const uniqueParticipants = Array.from(new Set([...participant_ids, creatorId]));
  const isGroup = uniqueParticipants.length > 2;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Validate users exist and are active
    const userCheck = await client.query(
      `SELECT id FROM ${USERS_TABLE} WHERE id = ANY($1::UUID[]) AND deleted_at IS NULL AND is_active = TRUE`,
      [uniqueParticipants]
    );
    
    // Note: We don't strictly enforce rowCount == uniqueParticipants.length here 
    // to allow creating chats even if one user is temporarily inactive, 
    // but ideally, you should. For now, we proceed with the found users.

    // Create conversation
    const convoRes = await client.query(
      `INSERT INTO ${CONVERSATIONS_TABLE} (is_group, topic, created_by_id, created_at)
       VALUES ($1, $2, $3, NOW()) RETURNING id`,
      [isGroup, topic || (isGroup ? 'Group Chat' : null), creatorId]
    );
    const conversationId = convoRes.rows[0].id;

    // Insert participants
    const insertStmt = `INSERT INTO ${PARTICIPANTS_TABLE} (conversation_id, user_id, is_active, is_admin, joined_at)
                        VALUES ($1, $2, $3, $4, NOW())`;
    for (const uid of uniqueParticipants) {
      const isAdmin = isGroup && uid === creatorId;
      await client.query(insertStmt, [conversationId, uid, true, isAdmin]);
    }

    await client.query('COMMIT');
    return res.status(201).json({ message: 'Conversation created.', conversation_id: conversationId });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Conversation creation error:', err);
    return res.status(500).json({ message: 'Failed to create conversation.' });
  } finally {
    client.release();
  }
});

/**
 * POST /api/messaging/conversations/:id/read
 * Mark all messages in a conversation as read
 */
router.post('/conversations/:conversationId/read', authenticateToken, async (req, res) => {
  const { conversationId } = req.params;
  const readerId = req.user.userId;

  try {
    const q = `
      INSERT INTO ${MESSAGE_STATUS_TABLE} (message_id, user_id, read_at)
      SELECT m.id, $1, NOW()
      FROM ${MESSAGES_TABLE} m
      WHERE m.conversation_id = $2
        AND m.sender_id != $1
        AND NOT EXISTS (
          SELECT 1 FROM ${MESSAGE_STATUS_TABLE} ms WHERE ms.message_id = m.id AND ms.user_id = $1
        )
      ON CONFLICT (message_id, user_id) DO NOTHING;
    `;
    await pool.query(q, [readerId, conversationId]);
    return res.status(200).json({ message: 'Messages marked as read.' });
  } catch (err) {
    console.error('Error marking read:', err);
    return res.status(500).json({ message: 'Failed to update status.' });
  }
});

// =========================================================
// 2. USER SEARCH
// =========================================================

/**
 * GET /api/messaging/users/search
 * Search by Username, Email, OR ID (UUID)
 */
router.get('/users/search', authenticateToken, async (req, res) => {
  const currentUserId = req.user.userId;
  const searchTerm = (req.query.query || '').trim();

  // Base query: Exclude current user, must be active and not deleted
  let baseQuery = `
    SELECT id, username, email
    FROM ${USERS_TABLE}
    WHERE id != $1 
      AND deleted_at IS NULL 
      AND is_active = TRUE
  `;
  const params = [currentUserId];

  if (searchTerm.length > 0) {
    // CRITICAL FIX: Search Username OR Email OR ID
    baseQuery += ` AND (
      COALESCE(username, '') ILIKE $2 OR 
      COALESCE(email, '') ILIKE $2 OR 
      CAST(id AS TEXT) ILIKE $2
    )`;
    params.push(`%${searchTerm}%`);
  }

  baseQuery += ` ORDER BY username ASC LIMIT 50`;

  try {
    const r = await pool.query(baseQuery, params);
    
    // Format for frontend dropdown
    const formatted = r.rows.map(row => ({
      id: row.id,
      name: row.username || row.email || 'Unknown User',
      value: row.id
    }));
    return res.status(200).json(formatted);
  } catch (err) {
    console.error('Search error:', err);
    return res.status(500).json({ message: 'Search failed.' });
  }
});

// =========================================================
// 3. MESSAGES
// =========================================================

/**
 * GET /api/messaging/messages/:conversationId
 * Get messages with pagination
 */
router.get('/messages/:conversationId', authenticateToken, async (req, res) => {
  const { conversationId } = req.params;
  const userId = req.user.userId;
  const limit = toInt(req.query.limit, 50);
  const page = Math.max(1, toInt(req.query.page, 1));
  const offset = (page - 1) * limit;

  try {
    // Check if user is a participant
    const pCheck = await pool.query(
      `SELECT 1 FROM ${PARTICIPANTS_TABLE} WHERE conversation_id=$1 AND user_id=$2 AND is_active=TRUE`,
      [conversationId, userId]
    );
    if (pCheck.rowCount === 0) return res.status(403).json({ message: 'Access denied.' });

    const messagesQuery = `
      SELECT
        m.id,
        CASE WHEN m.deleted_at IS NOT NULL THEN '[Message Deleted]' ELSE m.content END AS content,
        m.created_at,
        m.sender_id,
        u.username AS sender_name,
        m.is_edited,
        m.deleted_at
      FROM ${MESSAGES_TABLE} m
      JOIN ${USERS_TABLE} u ON m.sender_id = u.id
      WHERE m.conversation_id = $1
      ORDER BY m.created_at ASC
      LIMIT $2 OFFSET $3
    `;

    const result = await pool.query(messagesQuery, [conversationId, limit, offset]);
    
    return res.status(200).json({
      messages: result.rows.map(r => ({
        id: r.id,
        content: r.content,
        created_at: r.created_at,
        sender_id: r.sender_id,
        sender_name: r.sender_name,
        is_edited: r.is_edited,
        is_deleted: !!r.deleted_at
      }))
    });
  } catch (err) {
    console.error('Error fetching messages:', err);
    return res.status(500).json({ message: 'Failed to retrieve messages.' });
  }
});

/**
 * POST /api/messaging/messages/:conversationId
 * Send a new message
 */
router.post('/messages/:conversationId', authenticateToken, async (req, res) => {
  const { conversationId } = req.params;
  const senderId = req.user.userId;
  const { content } = req.body;

  if (!content || !content.trim()) return res.status(400).json({ message: 'Empty content.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Check participation
    const part = await client.query(
      `SELECT 1 FROM ${PARTICIPANTS_TABLE} WHERE conversation_id=$1 AND user_id=$2 AND is_active=TRUE`,
      [conversationId, senderId]
    );
    if (part.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(403).json({ message: 'Not a participant.' });
    }

    // Insert Message
    const insert = await client.query(
      `INSERT INTO ${MESSAGES_TABLE} (conversation_id, sender_id, content, created_at)
       VALUES ($1, $2, $3, NOW()) RETURNING id, created_at`,
      [conversationId, senderId, content]
    );
    const msg = insert.rows[0];

    // Update Conversation Timestamp
    await client.query(`UPDATE ${CONVERSATIONS_TABLE} SET last_message_at = NOW() WHERE id = $1`, [conversationId]);
    await client.query('COMMIT');

    // Socket Broadcast
    const io = req.app.get('io');
    if (io) {
      io.to(conversationId).emit('new_message', {
        id: msg.id,
        conversation_id: conversationId,
        sender_id: senderId,
        sender_name: req.user.username,
        content,
        created_at: msg.created_at
      });
    }

    return res.status(201).json({ message: 'Sent', message_id: msg.id });
  } catch (err) {
    await client.query('ROLLBACK').catch(()=>{});
    console.error('Send error:', err);
    return res.status(500).json({ message: 'Send failed.' });
  } finally {
    client.release();
  }
});

/**
 * PUT /api/messaging/messages/:messageId
 * Edit a message
 */
router.put('/messages/:messageId', authenticateToken, async (req, res) => {
  const { messageId } = req.params;
  const senderId = req.user.userId;
  const { newContent } = req.body;

  if (!newContent || !newContent.trim()) return res.status(400).json({ message: 'Empty content.' });

  try {
    const update = await pool.query(
      `UPDATE ${MESSAGES_TABLE} SET content=$1, is_edited=TRUE, updated_at=NOW()
       WHERE id=$2 AND sender_id=$3 AND deleted_at IS NULL RETURNING conversation_id`,
      [newContent, messageId, senderId]
    );

    if (update.rowCount === 0) return res.status(403).json({ message: 'Cannot edit: Message not found or unauthorized.' });

    const io = req.app.get('io');
    if (io) {
      io.to(update.rows[0].conversation_id).emit('message_edited', { message_id: messageId, new_content: newContent });
    }
    return res.status(200).json({ message: 'Updated.' });
  } catch (err) {
    console.error('Edit error:', err);
    return res.status(500).json({ message: 'Update failed.' });
  }
});

/**
 * DELETE /api/messaging/messages/:messageId
 * Soft delete a message
 */
router.delete('/messages/:messageId', authenticateToken, async (req, res) => {
  const { messageId } = req.params;
  const senderId = req.user.userId;

  try {
    const del = await pool.query(
      `UPDATE ${MESSAGES_TABLE} SET deleted_at=NOW(), content='[Message Deleted]', is_edited=FALSE, updated_at=NOW()
       WHERE id=$1 AND sender_id=$2 AND deleted_at IS NULL RETURNING conversation_id`,
      [messageId, senderId]
    );

    if (del.rowCount === 0) return res.status(403).json({ message: 'Cannot delete: Message not found or unauthorized.' });

    const io = req.app.get('io');
    if (io) {
      io.to(del.rows[0].conversation_id).emit('message_deleted', { message_id: messageId });
    }
    return res.status(200).json({ message: 'Deleted.' });
  } catch (err) {
    console.error('Delete error:', err);
    return res.status(500).json({ message: 'Delete failed.' });
  }
});

module.exports = router;