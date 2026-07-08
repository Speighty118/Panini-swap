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
      `SELECT * FROM stickers
       WHERE ${conditions.join(' AND ')}
       ORDER BY
         team_name,
         regexp_replace(sticker_number, '[^0-9]', '', 'g') = '' DESC,
         CAST(NULLIF(regexp_replace(sticker_number, '[^0-9]', '', 'g'), '') AS INTEGER) ASC,
         sticker_number ASC`,
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
// List distinct team names with their sticker number range,
// for building a team filter dropdown.
// ----------------------------------------------------------------
router.get('/teams', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         team_name,
         MIN(sticker_number) AS first_number,
         MAX(sticker_number) AS last_number,
         COUNT(*) AS sticker_count,
         MIN(CAST(NULLIF(regexp_replace(sticker_number, '[^0-9]', '', 'g'), '') AS INTEGER)) AS first_num_int,
         MAX(CAST(NULLIF(regexp_replace(sticker_number, '[^0-9]', '', 'g'), '') AS INTEGER)) AS last_num_int
       FROM stickers
       WHERE team_name IS NOT NULL
       GROUP BY team_name
       ORDER BY team_name`
    );
    // Build the display range using numeric sort rather than alphabetical,
    // so FWC1–FWC19 shows correctly instead of FWC1–FWC9
    const result = rows.map(r => {
      const prefix = r.first_number.replace(/[0-9]/g, '');
      return {
        ...r,
        first_number: r.first_num_int ? `${prefix}${r.first_num_int}` : r.first_number,
        last_number: r.last_num_int ? `${prefix}${r.last_num_int}` : r.last_number,
      };
    });
    res.json(result);
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
       ORDER BY
         s.team_name,
         regexp_replace(s.sticker_number, '[^0-9]', '', 'g') = '' DESC,
         CAST(NULLIF(regexp_replace(s.sticker_number, '[^0-9]', '', 'g'), '') AS INTEGER) ASC,
         s.sticker_number ASC`,
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
// Guards against reducing quantity below the number of copies
// currently committed to active swaps.
// ----------------------------------------------------------------
router.post('/me/duplicates', requireAuth, async (req, res) => {
  const { stickerId, quantity = 1 } = req.body;
  const userId = req.user.id;

  if (!stickerId || !Number.isInteger(quantity) || quantity < 1) {
    return res.status(400).json({ error: 'stickerId is required and quantity must be a positive integer' });
  }

  try {
    // Count how many copies are committed to active swaps
    const { rows: committed } = await pool.query(
      `SELECT COUNT(*) AS count
       FROM swap_items si
       JOIN swaps s ON s.id = si.swap_id
       WHERE si.from_user_id = $1
         AND si.sticker_id = $2
         AND s.status IN ('proposed', 'accepted', 'posted')`,
      [userId, stickerId]
    );
    const committedCount = parseInt(committed[0].count, 10);
    if (quantity < committedCount) {
      return res.status(409).json({
        error: `You have ${committedCount} ${committedCount === 1 ? 'copy' : 'copies'} of this sticker committed to active swaps. You cannot set the quantity below ${committedCount}.`,
      });
    }

    const { rows } = await pool.query(
      `INSERT INTO user_duplicates (user_id, sticker_id, quantity)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, sticker_id) DO UPDATE SET quantity = $3
       RETURNING *`,
      [userId, stickerId, quantity]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to add duplicate' });
  }
});

// ----------------------------------------------------------------
// DELETE /api/stickers/me/duplicates/:stickerId
// Removes a sticker from the user's duplicates list.
// BLOCKS deletion if the sticker is currently committed to a swap
// that's proposed, accepted, OR posted — covers the whole window
// where a swap partner is actively relying on it, not just the
// first two stages.
// ----------------------------------------------------------------
router.delete('/me/duplicates/:stickerId', requireAuth, async (req, res) => {
  const userId = req.user.id;
  const stickerId = req.params.stickerId;

  try {
    // Check if this sticker is in an active swap
    const { rows: conflicts } = await pool.query(
      `SELECT s.id AS swap_id
       FROM swap_items si
       JOIN swaps s ON s.id = si.swap_id
       WHERE si.from_user_id = $1
         AND si.sticker_id = $2
         AND s.status IN ('proposed', 'accepted', 'posted')
       LIMIT 1`,
      [userId, stickerId]
    );

    if (conflicts.length > 0) {
      return res.status(409).json({
        error: `This sticker is part of an active swap (#${conflicts[0].swap_id}). Please wait for that swap to complete or decline it before removing this sticker.`,
        swapId: conflicts[0].swap_id,
      });
    }

    await pool.query(
      `DELETE FROM user_duplicates WHERE user_id = $1 AND sticker_id = $2`,
      [userId, stickerId]
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

// ----------------------------------------------------------------
// DELETE /api/stickers/me/all
// Clears all of a user's spares and needs in one go — for anyone
// whose list has drifted a long way from their actual collection
// and would rather start fresh than delete things one at a time.
// Skips any spare currently committed to a swap that's still in
// progress, so a bulk reset can never break an active swap.
// ----------------------------------------------------------------
router.delete('/me/all', requireAuth, async (req, res) => {
  const userId = req.user.id;
  try {
    const { rows: deletedDuplicates } = await pool.query(
      `DELETE FROM user_duplicates
       WHERE user_id = $1
         AND sticker_id NOT IN (
           SELECT si.sticker_id FROM swap_items si
           JOIN swaps s ON s.id = si.swap_id
           WHERE si.from_user_id = $1 AND s.status IN ('proposed', 'accepted', 'posted')
         )
       RETURNING sticker_id`,
      [userId]
    );
    const { rows: deletedNeeds } = await pool.query(
      `DELETE FROM user_needs WHERE user_id = $1 RETURNING sticker_id`,
      [userId]
    );
    res.json({
      success: true,
      duplicatesCleared: deletedDuplicates.length,
      needsCleared: deletedNeeds.length,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to clear your lists' });
  }
});

module.exports = router;
