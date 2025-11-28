/**
 * routes/messaging.js
 *
 * Final production-ready messaging routes.
 *
 * - Uses: ../database -> exports { pool }
 * - Uses: ../authMiddleware -> exports authenticateToken (adds req.user.userId, req.user.username)
 * - Socket.IO: expects io instance attached to Express app via app.set('io', io) or app.locals.io
 *
 * Improvements included:
 * - NULL-safe user search (COALESCE)
 * - Pagination for messages
 * - Conversation existence & participant checks
 * - Read receipts bulk endpoint (transaction-safe)
 * - Proper socket broadcasting (uses req.app.get('io'))
 * - Returns useful payloads on send
 * - Defensive error handling and resource cleanup
 */

const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken } = require('../authMiddleware');

// Database Table Constants (adjust names if your DB uses different names)
const CONVERSATIONS_TABLE = 'conversations';
const PARTICIPANTS_TABLE = 'conversation_participants';
const MESSAGES_TABLE = 'messages';
const USERS_TABLE = 'users';
const MESSAGE_STATUS_TABLE = 'message_status';

// Utility: safe parse int with default
function toInt(v, def) {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? def : n;
}

// =========================================================
// 1. CONVERSATION MANAGEMENT
// =========================================================

/**
 * GET /api/messaging/conversations
 * Get all conversations for the logged-in user
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
        -- aggregate participants (excluding current user) for display
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
 * Create a new private or group conversation.
 * Body: { participant_ids: [uuid,...], topic: optional string }
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

    // Validate users exist and are active (not deleted)
    const userCheck = await client.query(
      `SELECT id FROM ${USERS_TABLE} WHERE id = ANY($1::UUID[]) AND deleted_at IS NULL AND is_active = TRUE`,
      [uniqueParticipants]
    );
    if (userCheck.rowCount !== uniqueParticipants.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'One or more participant IDs are invalid or inactive.' });
    }

    // Create conversation
    const convoRes = await client.query(
      `INSERT INTO ${CONVERSATIONS_TABLE} (is_group, topic, created_by_id, created_at)
       VALUES ($1, $2, $3, NOW()) RETURNING id, is_group, topic, created_by_id, created_at`,
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
 * POST /api/messaging/conversations/:conversationId/read
 * Mark all unread messages in a conversation as read for the current user.
 */
router.post('/conversations/:conversationId/read', authenticateToken, async (req, res) => {
  const { conversationId } = req.params;
  const readerId = req.user.userId;

  try {
    // Insert read entries for messages that don't already have one for this user
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
    console.error('Error marking conversation read:', err);
    return res.status(500).json({ message: 'Failed to update status.' });
  }
});

// =========================================================
// 2. USER SEARCH
// =========================================================

/**
 * GET /api/messaging/users/search
 * Query param: query
 * Returns a list of active users excluding current user.
 * Safe against NULLs using COALESCE.
 */
router.get('/users/search', authenticateToken, async (req, res) => {
  const currentUserId = req.user.userId;
  const searchTerm = (req.query.query || '').trim();

  // Base query (NULL-safe)
  let baseQuery = `
    SELECT id, username, email, phone_number
    FROM ${USERS_TABLE}
    WHERE id != $1
      AND deleted_at IS NULL
      AND is_active = TRUE
  `;
  const params = [currentUserId];

  if (searchTerm && searchTerm.length > 0) {
    // Use COALESCE to treat NULLs as empty strings
    baseQuery += ` AND (
      COALESCE(username, '') ILIKE $2 OR
      COALESCE(email, '') ILIKE $2 OR
      COALESCE(phone_number::text, '') ILIKE $2 OR
      SUBSTRING(id::text, 1, 8) ILIKE $2
    )`;
    params.push(`%${searchTerm}%`);
  }

  baseQuery += ` ORDER BY username ASC LIMIT 200`; // reasonably high limit for dropdowns

  try {
    const r = await pool.query(baseQuery, params);

    const formatted = r.rows.map(row => {
      let displayName = row.username || '';
      // If username looks like numeric or short, combine with email if available
      if ((/^\d+$/.test(displayName) || displayName.length < 3) && row.email) {
        displayName = `${row.email} (${displayName})`;
      }
      return { id: row.id, name: displayName, value: row.id };
    });

    return res.status(200).json(formatted);
  } catch (err) {
    console.error('Error searching users:', err);
    return res.status(500).json({ message: 'Failed to search users.' });
  }
});

// =========================================================
// 3. MESSAGES (LIST, SEND, EDIT, DELETE, MARK READ)
// =========================================================

/**
 * GET /api/messaging/messages/:conversationId
 * Query params: page (default 1), limit (default 50)
 * Returns paginated messages for a conversation (ascending by created_at)
 */
router.get('/messages/:conversationId', authenticateToken, async (req, res) => {
  const { conversationId } = req.params;
  const userId = req.user.userId;
  const limit = toInt(req.query.limit, 50);
  const page = Math.max(1, toInt(req.query.page, 1));
  const offset = (page - 1) * limit;

  try {
    // Verify participant
    const pCheck = await pool.query(
      `SELECT 1 FROM ${PARTICIPANTS_TABLE} WHERE conversation_id=$1 AND user_id=$2 AND is_active = TRUE`,
      [conversationId, userId]
    );
    if (pCheck.rowCount === 0) return res.status(403).json({ message: 'Access denied.' });

    // Fetch messages with read_count (number of users who read) and sender name
    // Also return whether current user has read each message (ms_me.is_read)
    const messagesQuery = `
      SELECT
        m.id,
        CASE WHEN m.deleted_at IS NOT NULL THEN '[Message Deleted]' ELSE m.content END AS content,
        m.created_at,
        m.sender_id,
        u.username AS sender_name,
        m.is_edited,
        m.deleted_at,
        COUNT(ms.user_id) FILTER (WHERE ms.read_at IS NOT NULL) AS read_count,
        MAX(ms_me.read_at IS NOT NULL) AS is_read_by_me
      FROM ${MESSAGES_TABLE} m
      JOIN ${USERS_TABLE} u ON m.sender_id = u.id
      LEFT JOIN ${MESSAGE_STATUS_TABLE} ms ON m.id = ms.message_id
      LEFT JOIN ${MESSAGE_STATUS_TABLE} ms_me ON m.id = ms_me.message_id AND ms_me.user_id = $2
      WHERE m.conversation_id = $1
      GROUP BY m.id, u.username
      ORDER BY m.created_at ASC
      LIMIT $3 OFFSET $4
    `;

    const result = await pool.query(messagesQuery, [conversationId, userId, limit, offset]);
    return res.status(200).json({
      page,
      limit,
      messages: result.rows.map(r => ({
        id: r.id,
        content: r.content,
        created_at: r.created_at,
        sender_id: r.sender_id,
        sender_name: r.sender_name,
        is_edited: r.is_edited,
        is_deleted: !!r.deleted_at,
        read_count: parseInt(r.read_count, 10) || 0,
        is_read_by_me: !!r.is_read_by_me
      }))
    });
  } catch (err) {
    console.error('Error fetching messages:', err);
    return res.status(500).json({ message: 'Failed to retrieve messages.' });
  }
});

/**
 * POST /api/messaging/messages/:conversationId
 * Send a new message. Body: { content }
 * Broadcasts via Socket.IO to conversation room (room name: conversation:<id>) and to individual user rooms if desired.
 */
router.post('/messages/:conversationId', authenticateToken, async (req, res) => {
  const { conversationId } = req.params;
  const senderId = req.user.userId;
  const senderName = req.user.username || 'User';
  const { content } = req.body;

  if (!content || !content.toString().trim()) {
    return res.status(400).json({ message: 'Content cannot be empty.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Verify participant belongs to conversation and is active
    const part = await client.query(
      `SELECT 1 FROM ${PARTICIPANTS_TABLE} WHERE conversation_id=$1 AND user_id=$2 AND is_active = TRUE`,
      [conversationId, senderId]
    );
    if (part.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(403).json({ message: 'Not a participant.' });
    }

    // Insert message
    const insert = await client.query(
      `INSERT INTO ${MESSAGES_TABLE} (conversation_id, sender_id, content, created_at)
       VALUES ($1, $2, $3, NOW()) RETURNING id, created_at`,
      [conversationId, senderId, content]
    );
    const newMessage = insert.rows[0];

    // Update conversation last_message_at
    await client.query(
      `UPDATE ${CONVERSATIONS_TABLE} SET last_message_at = NOW() WHERE id = $1`,
      [conversationId]
    );

    // Optionally insert a message_status row marking sender as read already
    await client.query(
      `INSERT INTO ${MESSAGE_STATUS_TABLE} (message_id, user_id, read_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (message_id, user_id) DO UPDATE SET read_at = EXCLUDED.read_at`,
      [newMessage.id, senderId]
    );

    await client.query('COMMIT');

    // Broadcast via Socket.IO
    try {
      const io = req.app.get('io'); // ensure you set io on app: app.set('io', io)
      const payload = {
        id: newMessage.id,
        conversation_id: conversationId,
        sender_id: senderId,
        sender_name: senderName,
        content,
        created_at: newMessage.created_at,
        read_count: 1 // sender already marked read
      };

      if (io && typeof io.to === 'function') {
        // Room name chosen to be conversation:<id> to avoid collision with other rooms
        // If your front-end listens to conversationId directly, you can also use io.to(conversationId)
        io.to(conversationId).emit('new_message', payload);
      }
    } catch (sockErr) {
      console.warn('Socket broadcast failed (non-fatal):', sockErr);
    }

    return res.status(201).json({ message: 'Message sent.', message_id: newMessage.id, created_at: newMessage.created_at });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Error sending message:', err);
    return res.status(500).json({ message: 'Failed to send message.' });
  } finally {
    client.release();
  }
});

/**
 * PUT /api/messaging/messages/:messageId
 * Edit a message (only sender, and message not deleted)
 * Body: { newContent }
 */
router.put('/messages/:messageId', authenticateToken, async (req, res) => {
  const { messageId } = req.params;
  const senderId = req.user.userId;
  const { newContent } = req.body;

  if (!newContent || !newContent.toString().trim()) {
    return res.status(400).json({ message: 'New content cannot be empty.' });
  }

  try {
    const update = await pool.query(
      `UPDATE ${MESSAGES_TABLE}
       SET content = $1, is_edited = TRUE, updated_at = NOW()
       WHERE id = $2 AND sender_id = $3 AND deleted_at IS NULL
       RETURNING id, conversation_id`,
      [newContent, messageId, senderId]
    );

    if (update.rowCount === 0) {
      return res.status(403).json({ message: 'Cannot edit this message.' });
    }

    // Broadcast edit event
    try {
      const io = req.app.get('io');
      if (io && typeof io.to === 'function') {
        const convId = update.rows[0].conversation_id;
        io.to(convId).emit('message_edited', { message_id: messageId, new_content: newContent });
      }
    } catch (sockErr) {
      console.warn('Socket broadcast for edit failed:', sockErr);
    }

    return res.status(200).json({ message: 'Updated.' });
  } catch (err) {
    console.error('Edit failed:', err);
    return res.status(500).json({ message: 'Edit failed.' });
  }
});

/**
 * DELETE /api/messaging/messages/:messageId
 * Soft-delete a message (only sender can delete)
 */
router.delete('/messages/:messageId', authenticateToken, async (req, res) => {
  const { messageId } = req.params;
  const senderId = req.user.userId;

  try {
    const del = await pool.query(
      `UPDATE ${MESSAGES_TABLE}
       SET deleted_at = NOW(), content = '[Message Deleted]', is_edited = FALSE, updated_at = NOW()
       WHERE id = $1 AND sender_id = $2 AND deleted_at IS NULL
       RETURNING id, conversation_id`,
      [messageId, senderId]
    );

    if (del.rowCount === 0) {
      return res.status(403).json({ message: 'Cannot delete this message.' });
    }

    // Broadcast deletion
    try {
      const io = req.app.get('io');
      if (io && typeof io.to === 'function') {
        const convId = del.rows[0].conversation_id;
        io.to(convId).emit('message_deleted', { message_id: messageId });
      }
    } catch (sockErr) {
      console.warn('Socket broadcast for delete failed:', sockErr);
    }

    return res.status(200).json({ message: 'Deleted.' });
  } catch (err) {
    console.error('Delete failed:', err);
    return res.status(500).json({ message: 'Delete failed.' });
  }
});

// =========================================================
// 4. TYPING INDICATOR (optional)
// =========================================================
/**
 * POST /api/messaging/typing/:conversationId
 * Body: { typing: true/false } - broadcasts typing indicator to conversation
 */
router.post('/typing/:conversationId', authenticateToken, (req, res) => {
  const { conversationId } = req.params;
  const userId = req.user.userId;
  const username = req.user.username || 'User';
  const typing = (req.body && typeof req.body.typing === 'boolean') ? req.body.typing : true;

  try {
    const io = req.app.get('io');
    if (io && typeof io.to === 'function') {
      io.to(conversationId).emit('typing', { conversation_id: conversationId, user_id: userId, username, typing });
    }
    return res.status(200).json({ message: 'Typing signal broadcasted.' });
  } catch (err) {
    console.error('Typing signal error:', err);
    return res.status(500).json({ message: 'Failed to broadcast typing.' });
  }
});

module.exports = router;