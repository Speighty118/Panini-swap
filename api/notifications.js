/**
 * Notifications — in-app notification system.
 *
 * createNotification() is a shared helper called by other modules
 * (swaps, messages, matching job) to create notifications.
 *
 * The router handles the user-facing API:
 *   GET  /api/notifications       — list unread + recent
 *   POST /api/notifications/read  — mark all as read
 *   POST /api/notifications/:id/read — mark one as read
 */

const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const { requireAuth } = require('./middleware/auth');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ----------------------------------------------------------------
// Shared helper — call this from anywhere to create a notification.
// Also fires a push notification if the user has subscribed.
// ----------------------------------------------------------------
async function createNotification(dbPool, { userId, type, title, body, swapId }) {
  try {
    await dbPool.query(
      `INSERT INTO notifications (user_id, type, title, body, swap_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, type, title, body || null, swapId || null]
    );
    // Fire push notification alongside in-app notification
    // Skip types already handled directly in swaps.js to avoid duplicates
    const skipTypes = ['swap_proposed', 'swap_accepted', 'swap_posted', 'swap_received', 'direct_message'];
    if (!skipTypes.includes(type)) {
      const { sendPushNotification } = require('./push');
      sendPushNotification(userId, { title, body: body || '' }).catch(() => {});
    }
  } catch (err) {
    console.error('Failed to create notification:', err.message);
  }
}

router.use(requireAuth);

// ----------------------------------------------------------------
// GET /api/notifications
// Returns the 30 most recent notifications for the logged-in user.
// Unread ones come first, then by recency.
// ----------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM notifications
       WHERE user_id = $1
       ORDER BY is_read ASC, created_at DESC
       LIMIT 30`,
      [req.user.id]
    );
    const unreadCount = rows.filter((n) => !n.is_read).length;
    res.json({ notifications: rows, unreadCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

// ----------------------------------------------------------------
// POST /api/notifications/read
// Mark all notifications as read.
// ----------------------------------------------------------------
router.post('/read', async (req, res) => {
  try {
    await pool.query(
      `UPDATE notifications SET is_read = TRUE WHERE user_id = $1 AND is_read = FALSE`,
      [req.user.id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to mark notifications as read' });
  }
});

// ----------------------------------------------------------------
// POST /api/notifications/:id/read
// Mark a single notification as read.
// ----------------------------------------------------------------
router.post('/:id/read', async (req, res) => {
  try {
    await pool.query(
      `UPDATE notifications SET is_read = TRUE WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to mark notification as read' });
  }
});

module.exports = { router, createNotification };
