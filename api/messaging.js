/**
 * Direct Messaging API
 *
 * GET  /api/messages                    — get all conversations for current user
 * POST /api/messages                    — start or continue a conversation
 * GET  /api/messages/:conversationId    — get messages in a conversation
 * POST /api/messages/:conversationId    — send a message in a conversation
 * POST /api/messages/:messageId/read    — mark conversation as read
 * POST /api/messages/:messageId/report  — report a message
 */

const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const { requireAuth } = require('./middleware/auth');
const { sendPushNotification } = require('./push');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Apply auth to all messaging routes
router.use(requireAuth);

// ----------------------------------------------------------------
// GET /api/messages
// Get all conversations for the current user, with latest message
// and unread count.
// ----------------------------------------------------------------
router.get('/', async (req, res) => {
  const userId = req.user.id;
  try {
    const { rows } = await pool.query(
      `SELECT
         c.id AS conversation_id,
         c.created_at,
         -- Other participant
         u.id AS other_user_id,
         u.name AS other_user_name,
         u.profile_photo AS other_user_photo,
         u.ambassador_badge AS other_user_ambassador_badge,
         -- Latest message
         lm.body AS last_message,
         lm.created_at AS last_message_at,
         lm.sender_id AS last_sender_id,
         -- Unread count
         COUNT(dm.id) FILTER (WHERE dm.read_at IS NULL AND dm.sender_id != $1) AS unread_count
       FROM conversations c
       JOIN conversation_participants cp ON cp.conversation_id = c.id AND cp.user_id = $1
       JOIN conversation_participants cp2 ON cp2.conversation_id = c.id AND cp2.user_id != $1
       JOIN users u ON u.id = cp2.user_id
       LEFT JOIN direct_messages dm ON dm.conversation_id = c.id
       LEFT JOIN LATERAL (
         SELECT body, created_at, sender_id
         FROM direct_messages
         WHERE conversation_id = c.id
         ORDER BY created_at DESC
         LIMIT 1
       ) lm ON TRUE
       GROUP BY c.id, c.created_at, u.id, u.name, u.profile_photo, u.ambassador_badge, lm.body, lm.created_at, lm.sender_id
       ORDER BY COALESCE(lm.created_at, c.created_at) DESC`,
      [userId]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch conversations' });
  }
});

// ----------------------------------------------------------------
// POST /api/messages
// Start a new conversation with a user, or return existing one.
// Body: { recipientId, body }
// ----------------------------------------------------------------
router.post('/', async (req, res) => {
  const senderId = req.user.id;
  const { recipientId, body } = req.body;
  if (!recipientId || !body?.trim()) {
    return res.status(400).json({ error: 'recipientId and body required' });
  }
  if (recipientId === senderId) {
    return res.status(400).json({ error: 'Cannot message yourself' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Check if conversation already exists between these two users
    const { rows: existing } = await client.query(
      `SELECT c.id FROM conversations c
       JOIN conversation_participants cp1 ON cp1.conversation_id = c.id AND cp1.user_id = $1
       JOIN conversation_participants cp2 ON cp2.conversation_id = c.id AND cp2.user_id = $2`,
      [senderId, recipientId]
    );

    let conversationId;
    if (existing.length > 0) {
      conversationId = existing[0].id;
    } else {
      const { rows: newConv } = await client.query(
        `INSERT INTO conversations DEFAULT VALUES RETURNING id`
      );
      conversationId = newConv[0].id;
      await client.query(
        `INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1, $2), ($1, $3)`,
        [conversationId, senderId, recipientId]
      );
    }

    const { rows: msgRows } = await client.query(
      `INSERT INTO direct_messages (conversation_id, sender_id, body)
       VALUES ($1, $2, $3) RETURNING *`,
      [conversationId, senderId, body.trim()]
    );

    // Notify recipient
    await client.query(
      `INSERT INTO notifications (user_id, type, title, body)
       VALUES ($1, 'direct_message', $2, $3)`,
      [recipientId, 'New message', `You have a new message from ${req.user.name || 'a user'}`]
    ).catch(() => {});

    // Push notification
    sendPushNotification(recipientId, {
      title: '💬 New message',
      body: `${req.user.name || 'Someone'}: ${body.trim().slice(0, 80)}`,
    }).catch(() => {});

    await client.query('COMMIT');
    res.status(201).json({ conversationId, message: msgRows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed to send message' });
  } finally {
    client.release();
  }
});

// ----------------------------------------------------------------
// GET /api/messages/:conversationId
// Get all messages in a conversation. Marks them as read.
// ----------------------------------------------------------------
router.get('/:conversationId', async (req, res) => {
  const userId = req.user.id;
  const { conversationId } = req.params;
  try {
    // Verify user is a participant
    const { rows: partRows } = await pool.query(
      `SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2`,
      [conversationId, userId]
    );
    if (!partRows.length) return res.status(403).json({ error: 'Not your conversation' });

    // Get messages
    const { rows } = await pool.query(
      `SELECT dm.*, u.name AS sender_name, u.profile_photo AS sender_photo
       FROM direct_messages dm
       JOIN users u ON u.id = dm.sender_id
       WHERE dm.conversation_id = $1 AND dm.reported = FALSE
       ORDER BY dm.created_at ASC`,
      [conversationId]
    );

    // Mark unread messages as read
    await pool.query(
      `UPDATE direct_messages SET read_at = NOW()
       WHERE conversation_id = $1 AND sender_id != $2 AND read_at IS NULL`,
      [conversationId, userId]
    );

    // Get other participant info
    const { rows: otherRows } = await pool.query(
      `SELECT u.id, u.name, u.profile_photo, u.ambassador_badge FROM conversation_participants cp
       JOIN users u ON u.id = cp.user_id
       WHERE cp.conversation_id = $1 AND cp.user_id != $2`,
      [conversationId, userId]
    );

    res.json({ messages: rows, otherUser: otherRows[0] || null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// ----------------------------------------------------------------
// POST /api/messages/:conversationId/send
// Send a message in an existing conversation.
// ----------------------------------------------------------------
router.post('/:conversationId/send', async (req, res) => {
  const userId = req.user.id;
  const { conversationId } = req.params;
  const { body } = req.body;
  if (!body?.trim()) return res.status(400).json({ error: 'Message body required' });

  try {
    // Verify participant
    const { rows: partRows } = await pool.query(
      `SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2`,
      [conversationId, userId]
    );
    if (!partRows.length) return res.status(403).json({ error: 'Not your conversation' });

    const { rows } = await pool.query(
      `INSERT INTO direct_messages (conversation_id, sender_id, body)
       VALUES ($1, $2, $3) RETURNING *`,
      [conversationId, userId, body.trim()]
    );

    // Notify other participant
    const { rows: otherRows } = await pool.query(
      `SELECT cp.user_id FROM conversation_participants cp
       WHERE cp.conversation_id = $1 AND cp.user_id != $2`,
      [conversationId, userId]
    );
    if (otherRows[0]) {
      await pool.query(
        `INSERT INTO notifications (user_id, type, title, body)
         VALUES ($1, 'direct_message', $2, $3)`,
        [otherRows[0].user_id, 'New message', `You have a new message from ${req.user.name || 'a user'}`]
      ).catch(() => {});

      // Push notification
      sendPushNotification(otherRows[0].user_id, {
        title: '💬 New message',
        body: `${req.user.name || 'Someone'}: ${req.body.body?.trim().slice(0, 80) || ''}`,
      }).catch(() => {});
    }

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// ----------------------------------------------------------------
// POST /api/messages/:messageId/report
// Report a message for review by admin.
// ----------------------------------------------------------------
router.post('/:messageId/report', async (req, res) => {
  const { messageId } = req.params;
  const { reason } = req.body;
  try {
    await pool.query(
      `UPDATE direct_messages SET reported = TRUE, report_reason = $1 WHERE id = $2`,
      [reason || null, messageId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to report message' });
  }
});

module.exports = router;
