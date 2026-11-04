/**
 * Donation tracking API.
 * 
 * POST /api/donations/click  — log a donate button click before redirecting
 * GET  /api/donations         — admin only, list all clicks
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

// ----------------------------------------------------------------
// POST /api/donations/click
// Log a donate button click. Auth optional — logged-in users are
// identified, anonymous clicks are still tracked by location.
// Body: { location }  — e.g. 'swap_confirmed', 'dashboard', 'footer'
// ----------------------------------------------------------------
router.post('/click', async (req, res) => {
  const { location } = req.body;

  let userId = null;
  let userName = null;
  let userEmail = null;
  try {
    const jwt = require('jsonwebtoken');
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) {
      const decoded = jwt.verify(header.slice(7), process.env.JWT_SECRET);
      userId = decoded.userId;
      const { rows } = await pool.query(
        `SELECT name, email FROM users WHERE id = $1`,
        [userId]
      );
      if (rows[0]) { userName = rows[0].name; userEmail = rows[0].email; }
    }
  } catch { /* anonymous click, fine */ }

  try {
    await pool.query(
      `INSERT INTO donation_clicks (user_id, user_name, user_email, location, clicked_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [userId, userName, userEmail, typeof location === 'string' ? location.slice(0, 100) : 'unknown']
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Donation click log error:', err);
    res.json({ success: true }); // don't block the redirect on a logging error
  }
});

// Admin-attested recovery of an original event copied from RevenueCat history.
// Records reporting data only: never charges, grants membership or sends messages.
router.post('/apple-recover', requireAdmin, async (req,res)=>{
 const {normalize,record}=require('./apple_support');
 if(req.body?.verifiedInRevenueCat!==true)return res.status(400).json({error:'Verify this original event in RevenueCat first.'});
 const event=req.body.event;
 try {if(!normalize(event))throw Error();}catch{return res.status(400).json({error:'A valid production Apple support payment event is required.'});}
 try {await record(pool,event,'admin_recovery');res.json({recorded:true});}
 catch{return res.status(503).json({error:'Recovery could not be saved. Retry with the same event ID.'});}
});

// Stripe is queried live so a checkout redirect is never counted as a payment.
router.get('/report', requireAdmin, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const {parsePeriod, readSessions, summarizeSessions}=require('./donation_report');
  let period;
  try { period=parsePeriod(req.query); } catch(error) { return res.status(400).json({error:error.message}); }
  try {
    const stripe=require('stripe')(process.env.STRIPE_SECRET_KEY);
    const {sessions,complete}=await readSessions(stripe,period);
    const summary=summarizeSessions(sessions);
    const ids=[...new Set(summary.payments.map(p=>Number(p.userId)).filter(Number.isSafeInteger))];
    const users=ids.length ? (await pool.query('SELECT id,name,email FROM users WHERE id = ANY($1::int[])',[ids])).rows : [];
    const byId=new Map(users.map(u=>[String(u.id),u]));
    summary.payments=summary.payments.map(p=>({...p,name:byId.get(p.userId)?.name || p.name,email:byId.get(p.userId)?.email || p.email}));
    const params=[period.from,period.to];
    const clicks=await pool.query(`SELECT location, COUNT(*)::int AS events, COUNT(DISTINCT user_id)::int AS identified_users
      FROM donation_clicks WHERE clicked_at >= $1 AND clicked_at < $2 GROUP BY location ORDER BY events DESC`,params);
    const recent=await pool.query(`SELECT user_name,user_email,location,clicked_at FROM donation_clicks
      WHERE clicked_at >= $1 AND clicked_at < $2 ORDER BY clicked_at DESC LIMIT 200`,params);
    let apple;
    try {apple={available:true,...await require('./apple_support').report(pool,period)};}
    catch {apple={available:false,error:'Apple payment records are temporarily unavailable.'};}
    res.json({...summary,apple,combinedGrossPence:apple.available?summary.grossPence+apple.grossPence:null,complete,from:period.from,to:period.to,activity:clicks.rows,recentActivity:recent.rows});
  } catch(error) {
    console.error('Donation report unavailable:',error.type || error.code || 'unknown');
    res.status(502).json({error:'Donation report unavailable. No totals are shown because the payment data could not be verified.'});
  }
});

// ----------------------------------------------------------------
// GET /api/donations
// Admin only — all donation clicks with user info.
// ----------------------------------------------------------------
router.get('/', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM donation_clicks ORDER BY clicked_at DESC LIMIT 500`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch donation clicks' });
  }
});

module.exports = router;
