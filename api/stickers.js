/**
 * Sticker inventory endpoints: browse the master sticker list,
 * and manage the logged-in user's duplicates and needs.
 * Mount under /api/stickers.
 */

const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const { requireAuth } = require('./middleware/auth');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ----------------------------------------------------------------
// GET /api/stickers
// Browse the master sticker list, optionally filtered by team
// or search text. Used to populate the "add sticker" pickers.
// ----------------------------------------------------------------
router.get('/', async (req, res) => {
  const { team, search, albumId = 1 } = req.query;

  try {
    const conditions = ['album_id = $1'];
    const params = [albumId];

    if (team) {
      params.push(team);
      conditions.push(`team_name = $${params.length}`);
    }
    if (search) {
      params.push(`%${search}%`);
      conditions.push(`(description ILIKE $${params.length} OR sticker_number ILIKE $${params.length})`);
    }

    const { rows } = await pool.query(
      `SELECT * FROM stickers WHERE ${conditions.join(' AND ')} ORDER BY sticker_number`,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch stickers' });
  }
});

// ----------------------------------------------------------------
// GET /api/stickers/teams
// List distinct team names, for building a team filter dropdown.
// ----------------------------------------------------------------
router.get('/teams', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT team_name FROM stickers WHERE team_name IS NOT NULL ORDER BY team_name`
    );
    res.json(rows.map(r => r.team_name));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch teams' });
  }
});

// ----------------------------------------------------------------
// GET /api/stickers/me/duplicates
// ----------------------------------------------------------------
router.get('/me/duplicates', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT ud.id, ud.quantity, s.id AS sticker_id, s.sticker_number, s.description, s.team_name, s.is_shiny
       FROM user_duplicates ud
       JOIN stickers s ON s.id = ud.sticker_id
       WHERE ud.user_id = $1
       ORDER BY s.sticker_number`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch duplicates' });
  }
});

// ----------------------------------------------------------------
// POST /api/stickers/me/duplicates
// Body: { stickerId, quantity }  — upserts (adds or updates count)
// ----------------------------------------------------------------
router.post('/me/duplicates', requireAuth, async (req, res) => {
  const { stickerId, quantity = 1 } = req.body;

  if (!stickerId || !Number.isInteger(quantity) || quantity < 1) {
    return res.status(400).json({ error: 'stickerId is required and quantity must be a positive integer' });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO user_duplicates (user_id, sticker_id, quantity)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, sticker_id) DO UPDATE SET quantity = $3
       RETURNING *`,
      [req.user.id, stickerId, quantity]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to add duplicate' });
  }
});

// ----------------------------------------------------------------
// DELETE /api/stickers/me/duplicates/:stickerId
// ----------------------------------------------------------------
router.delete('/me/duplicates/:stickerId', requireAuth, async (req, res) => {
  try {
    await pool.query(
      `DELETE FROM user_duplicates WHERE user_id = $1 AND sticker_id = $2`,
      [req.user.id, req.params.stickerId]
    );
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to remove duplicate' });
  }
});

// ----------------------------------------------------------------
// GET /api/stickers/me/needs
// ----------------------------------------------------------------
router.get('/me/needs', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT un.id, s.id AS sticker_id, s.sticker_number, s.description, s.team_name, s.is_shiny
       FROM user_needs un
       JOIN stickers s ON s.id = un.sticker_id
       WHERE un.user_id = $1
       ORDER BY s.sticker_number`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch needs' });
  }
});

// ----------------------------------------------------------------
// POST /api/stickers/me/needs
// Body: { stickerId }
// ----------------------------------------------------------------
router.post('/me/needs', requireAuth, async (req, res) => {
  const { stickerId } = req.body;
  if (!stickerId) return res.status(400).json({ error: 'stickerId is required' });

  try {
    const { rows } = await pool.query(
      `INSERT INTO user_needs (user_id, sticker_id)
       VALUES ($1, $2)
       ON CONFLICT (user_id, sticker_id) DO NOTHING
       RETURNING *`,
      [req.user.id, stickerId]
    );
    res.status(201).json(rows[0] || { message: 'Already in needs list' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to add need' });
  }
});

// ----------------------------------------------------------------
// DELETE /api/stickers/me/needs/:stickerId
// ----------------------------------------------------------------
router.delete('/me/needs/:stickerId', requireAuth, async (req, res) => {
  try {
    await pool.query(
      `DELETE FROM user_needs WHERE user_id = $1 AND sticker_id = $2`,
      [req.user.id, req.params.stickerId]
    );
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to remove need' });
  }
});

// ----------------------------------------------------------------
// POST /api/stickers/me/duplicates/bulk
// Body: { stickerIds: [id, id, ...] }
// Adds multiple duplicates at once (quantity 1 each, upserts).
// ----------------------------------------------------------------
router.post('/me/duplicates/bulk', requireAuth, async (req, res) => {
  const { stickerIds } = req.body;
  if (!Array.isArray(stickerIds) || stickerIds.length === 0) {
    return res.status(400).json({ error: 'stickerIds must be a non-empty array' });
  }
  if (stickerIds.length > 100) {
    return res.status(400).json({ error: 'Maximum 100 stickers per bulk add' });
  }
  try {
    for (const id of stickerIds) {
      await pool.query(
        `INSERT INTO user_duplicates (user_id, sticker_id, quantity)
         VALUES ($1, $2, 1)
         ON CONFLICT (user_id, sticker_id) DO NOTHING`,
        [req.user.id, id]
      );
    }
    res.status(201).json({ added: stickerIds.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to bulk add duplicates' });
  }
});

// ----------------------------------------------------------------
// POST /api/stickers/me/needs/bulk
// Body: { stickerIds: [id, id, ...] }
// Adds multiple needs at once (upserts, ignores already-added).
// ----------------------------------------------------------------
router.post('/me/needs/bulk', requireAuth, async (req, res) => {
  const { stickerIds } = req.body;
  if (!Array.isArray(stickerIds) || stickerIds.length === 0) {
    return res.status(400).json({ error: 'stickerIds must be a non-empty array' });
  }
  if (stickerIds.length > 100) {
    return res.status(400).json({ error: 'Maximum 100 stickers per bulk add' });
  }
  try {
    for (const id of stickerIds) {
      await pool.query(
        `INSERT INTO user_needs (user_id, sticker_id)
         VALUES ($1, $2)
         ON CONFLICT (user_id, sticker_id) DO NOTHING`,
        [req.user.id, id]
      );
    }
    res.status(201).json({ added: stickerIds.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to bulk add needs' });
  }
});

module.exports = router;
