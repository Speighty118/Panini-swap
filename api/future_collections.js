const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const { requireAuth } = require('./middleware/auth');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const COLLECTIONS = [
  { key: 'wc_2030', label: 'FIFA World Cup 2030', emoji: '>' },
  { key: 'euro_2028', label: 'UEFA Euro 2028', emoji: '>' },
  { key: 'nations_league', label: 'UEFA Nations League', emoji: '>' },
  { key: 'pl_stickers', label: 'Panini Premier League Stickers', emoji: '>' },
  { key: 'pl_adrenalyn', label: 'Panini Premier League Adrenalyn XL', emoji: '>' },
  { key: 'match_attax_cl', label: 'Match Attax Champions League', emoji: '>' },
  { key: 'match_attax_pl', label: 'Match Attax Premier League', emoji: '>' },
  { key: 'wwc_2027', label: "Women's World Cup 2027", emoji: '>' },
  { key: 'weuro_2029', label: "Women's Euro 2029", emoji: '>' },
  { key: 'club_wc', label: 'FIFA Club World Cup', emoji: '>' },
  { key: 'copa_2028', label: 'Copa America 2028', emoji: '>' },
  { key: 'afcon', label: 'Africa Cup of Nations', emoji: '>' },
  { key: 'conference_league', label: 'UEFA Conference League', emoji: '>' },
  { key: 'scottish_prem', label: 'Scottish Premiership Stickers', emoji: '>' },
  { key: 'efl', label: 'EFL Sticker Collection', emoji: '>' },
];

router.get('/me', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT collection_key FROM future_collection_votes WHERE user_id = $1',
      [req.user.id]
    );
    res.json({ voted: rows.map(function(r) { return r.collection_key; }), collections: COLLECTIONS });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch votes' });
  }
});

router.post('/vote', requireAuth, async (req, res) => {
  const key = req.body.key;
  const selected = req.body.selected;
  if (!COLLECTIONS.find(function(c) { return c.key === key; })) {
    return res.status(400).json({ error: 'Invalid collection key' });
  }
  try {
    if (selected) {
      await pool.query(
        'INSERT INTO future_collection_votes (user_id, collection_key) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [req.user.id, key]
      );
    } else {
      await pool.query(
        'DELETE FROM future_collection_votes WHERE user_id = $1 AND collection_key = $2',
        [req.user.id, key]
      );
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save vote' });
  }
});

router.get('/results', async (req, res) => {
  const secret = req.headers['x-admin-secret'];
  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const { rows } = await pool.query(
      'SELECT collection_key, COUNT(*) AS votes FROM future_collection_votes GROUP BY collection_key ORDER BY votes DESC'
    );
    const total_users = await pool.query('SELECT COUNT(*) FROM users');
    const totalUsers = parseInt(total_users.rows[0].count);
    const results = rows.map(function(r) {
      const col = COLLECTIONS.find(function(c) { return c.key === r.collection_key; });
      return {
        key: r.collection_key,
        label: col ? col.label : r.collection_key,
        emoji: col ? col.emoji : '>',
        votes: parseInt(r.votes),
        pct: Math.round((parseInt(r.votes) / totalUsers) * 100),
      };
    });
    res.json({ results: results, totalUsers: totalUsers, collections: COLLECTIONS });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch results' });
  }
});

module.exports = router;
