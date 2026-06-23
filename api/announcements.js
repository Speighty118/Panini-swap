/**
 * Announcements API — "What's new" changelog for users.
 *
 * GET  /api/announcements         — list all announcements (newest first)
 * POST /api/announcements         — admin: create a new announcement
 * POST /api/announcements/read    — mark all as read for current user
 */

const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function requireAdmin(req, res, next) {
  const provided = req.headers['x-admin-secret'];
  if (!process.env.ADMIN_SECRET || provided !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// GET /api/announcements
// Returns all announcements plus an unread count for the current user.
router.get('/', async (req, res) => {
  try {
    const { rows: announcements } = await pool.query(
      `SELECT * FROM announcements ORDER BY created_at DESC LIMIT 50`
    );

    let unreadCount = 0;
    if (req.user) {
      const { rows: userRows } = await pool.query(
        `SELECT last_read_announcements FROM users WHERE id = $1`,
        [req.user.id]
      );
      const lastRead = userRows[0]?.last_read_announcements;
      if (!lastRead) {
        unreadCount = announcements.length;
      } else {
        unreadCount = announcements.filter(a => new Date(a.created_at) > new Date(lastRead)).length;
      }
    }

    res.json({ announcements, unreadCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch announcements' });
  }
});

// POST /api/announcements/read
// Mark all announcements as read for the current user.
router.post('/read', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  try {
    await pool.query(
      `UPDATE users SET last_read_announcements = NOW() WHERE id = $1`,
      [req.user.id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to mark as read' });
  }
});

// POST /api/announcements — admin only
router.post('/', requireAdmin, async (req, res) => {
  const { title, body } = req.body;
  if (!title || !body) return res.status(400).json({ error: 'Title and body required' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO announcements (title, body) VALUES ($1, $2) RETURNING *`,
      [title, body]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create announcement' });
  }
});

// DELETE /api/announcements/:id — admin only
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query(`DELETE FROM announcements WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete announcement' });
  }
});

module.exports = router;
