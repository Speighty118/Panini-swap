/**
 * Chat API — messages between swap partners.
 * Mount under /api/swaps/:swapId/messages.
 *
 * Messages are only accessible to the two participants in a swap,
 * and only once the swap has been proposed (not just matched).
 */

const express = require('express');
const router = express.Router({ mergeParams: true }); // inherit :swapId from parent
const { Pool } = require('pg');
const { requireAuth } = require('./middleware/auth');
const { createNotification } = require('./notifications');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

router.use(requireAuth);

// Shared guard: verify the swap exists and the requester is a participant.
async function requireSwapParticipant(req, res, next) {
  const { swapId } = req.params;
  const userId = req.user.id;
  try {
    const { rows } = await pool.query('SELECT * FROM swaps WHERE id = $1', [swapId]);
    const swap = rows[0];
    if (!swap) return res.status(404).json({ error: 'Swap not found' });
    if (swap.user_a_id !== userId && swap.user_b_id !== userId) {
      return res.status(403).json({ error: 'Not your swap' });
    }
    req.swap = swap;
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
}

// ----------------------------------------------------------------
// GET /api/swaps/:swapId/messages
// Returns all messages for this swap, oldest first.
// ----------------------------------------------------------------
router.get('/', requireSwapParticipant, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT m.*, u.name AS sender_name, u.profile_photo AS sender_photo
       FROM messages m
       JOIN users u ON u.id = m.sender_id
       WHERE m.swap_id = $1
       ORDER BY m.created_at ASC`,
      [req.params.swapId]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// ----------------------------------------------------------------
// POST /api/swaps/:swapId/messages
// Body: { body }
// Sends a message and creates a notification for the other party.
// ----------------------------------------------------------------
router.post('/', requireSwapParticipant, async (req, res) => {
  const { body } = req.body;
  const userId = req.user.id;
  const swap = req.swap;

  if (!body || !body.trim()) {
    return res.status(400).json({ error: 'Message body is required' });
  }
  if (body.length > 2000) {
    return res.status(400).json({ error: 'Message too long (max 2000 characters)' });
  }

  try {
    const { rows: userRows } = await pool.query('SELECT name FROM users WHERE id = $1', [userId]);
    const senderName = userRows[0]?.name || 'Someone';

    const { rows } = await pool.query(
      `INSERT INTO messages (swap_id, sender_id, body)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [swap.id, userId, body.trim()]
    );
    const message = rows[0];

    // Notify the other participant
    const recipientId = swap.user_a_id === userId ? swap.user_b_id : swap.user_a_id;
    await createNotification(pool, {
      userId: recipientId,
      type: 'new_message',
      title: `New message from ${senderName}`,
      body: body.trim().slice(0, 100) + (body.length > 100 ? '…' : ''),
      swapId: swap.id,
    });

    res.status(201).json({ ...message, sender_name: senderName });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

module.exports = router;
