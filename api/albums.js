/**
 * Album listing endpoint — powers the frontend's album switcher.
 * Mount under /api/albums.
 */

const express = require('express');
const router = express.Router();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ----------------------------------------------------------------
// GET /api/albums
// List every album (id, name), oldest first.
// ----------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT id, name FROM albums ORDER BY id`);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch albums' });
  }
});

module.exports = router;
