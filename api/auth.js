/**
 * Auth API endpoints: signup, login, get/update own profile.
 * Mount under /api/auth.
 */

const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const { requireAuth, JWT_SECRET } = require('./middleware/auth');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const SALT_ROUNDS = 12;
const TOKEN_EXPIRY = '30d';

function signToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
}

function publicUser(row) {
  // Strip password_hash before ever sending a user object to the client
  const { password_hash, ...rest } = row;
  return rest;
}

// ----------------------------------------------------------------
// POST /api/auth/signup
// Body: { name, email, password }
// ----------------------------------------------------------------
router.post('/signup', async (req, res) => {
  const { name, email, password } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({ error: 'name, email, and password are required' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  try {
    const { rows: existing } = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existing[0]) {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

    const { rows } = await pool.query(
      `INSERT INTO users (name, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [name, email.toLowerCase(), passwordHash]
    );

    const user = rows[0];
    const token = signToken(user.id);

    res.status(201).json({ token, user: publicUser(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create account' });
  }
});

// ----------------------------------------------------------------
// POST /api/auth/login
// Body: { email, password }
// ----------------------------------------------------------------
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }

  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
    const user = rows[0];

    // Generic error for both "no such user" and "wrong password" —
    // don't leak which one it was.
    if (!user || !user.password_hash) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    if (!user.is_active) {
      return res.status(403).json({ error: 'This account has been deactivated' });
    }

    const token = signToken(user.id);
    res.json({ token, user: publicUser(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to log in' });
  }
});

// ----------------------------------------------------------------
// GET /api/auth/me
// Returns the logged-in user's own profile (includes address —
// this is the only endpoint that should return your own address
// back to you for editing purposes).
// ----------------------------------------------------------------
router.get('/me', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json(publicUser(rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// ----------------------------------------------------------------
// PUT /api/auth/me
// Update own profile (name, address fields). Email/password
// changes are deliberately left out of this simple endpoint —
// handle those separately with re-verification if you add them.
// ----------------------------------------------------------------
router.put('/me', requireAuth, async (req, res) => {
  const { name, address_line1, address_line2, city, postcode, country } = req.body;

  try {
    const { rows } = await pool.query(
      `UPDATE users
       SET name = COALESCE($1, name),
           address_line1 = COALESCE($2, address_line1),
           address_line2 = COALESCE($3, address_line2),
           city = COALESCE($4, city),
           postcode = COALESCE($5, postcode),
           country = COALESCE($6, country)
       WHERE id = $7
       RETURNING *`,
      [name, address_line1, address_line2, city, postcode, country, req.user.id]
    );
    res.json(publicUser(rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

module.exports = router;
