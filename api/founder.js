/**
 * Founder Membership — one-time £14.99 supporter purchase.
 *
 * IMPORTANT — env vars needed in Railway:
 *   STRIPE_SECRET_KEY      - your Stripe secret key (sk_live_... or sk_test_...)
 *   STRIPE_WEBHOOK_SECRET  - the signing secret for the webhook endpoint
 *                            you'll create in the Stripe dashboard (see
 *                            deployment notes)
 *   FRONTEND_URL           - e.g. https://gotonespare.com — used to build
 *                            the success/cancel redirect URLs
 *
 * IMPORTANT — the `requireAuth` import below matches the pattern used
 * in your other route files. If your project imports it from a
 * different path, just adjust this one line — everything else is
 * self-contained.
 */

const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const { requireAuth } = require('./middleware/auth');
const { sendFounderWelcomeEmail } = require('./email');
const { createNotification } = require('./notifications');

const FOUNDER_PRICE_PENCE = 1499; // £14.99

// ----------------------------------------------------------------
// GET /api/founder/count
// Public — live count for the "23 supporters" style counter.
// ----------------------------------------------------------------
router.get('/count', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*) FROM users WHERE founder_member = TRUE`
    );
    res.json({ count: parseInt(rows[0].count, 10) });
  } catch (err) {
    console.error('Founder count error:', err.message);
    res.status(500).json({ error: 'Failed to load founder count' });
  }
});

// ----------------------------------------------------------------
// GET /api/founder/status
// Whether the logged-in user is already a Founder.
// ----------------------------------------------------------------
router.get('/status', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT founder_member, founder_since FROM users WHERE id = $1`,
      [req.user.id]
    );
    const user = rows[0];
    res.json({
      isFounder: Boolean(user?.founder_member),
      founderSince: user?.founder_since || null,
    });
  } catch (err) {
    console.error('Founder status error:', err.message);
    res.status(500).json({ error: 'Failed to load founder status' });
  }
});

// ----------------------------------------------------------------
// POST /api/founder/checkout
// Creates a Stripe Checkout Session for the one-time £14.99 payment
// and returns the URL to redirect the browser to. Uses inline
// price_data rather than a pre-created Stripe Price, so no dashboard
// product setup is needed beyond having Stripe API keys.
// ----------------------------------------------------------------
router.post('/checkout', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT founder_member FROM users WHERE id = $1`, [req.user.id]);
    if (rows[0]?.founder_member) {
      return res.status(400).json({ error: "You're already a Founder member — thank you!" });
    }

    const frontendUrl = process.env.FRONTEND_URL || 'https://gotonespare.com';
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'gbp',
            unit_amount: FOUNDER_PRICE_PENCE,
            product_data: {
              name: 'Got One Spare? — Founder Membership',
              description: 'One-time contribution supporting hosting, development, and future sticker collections.',
            },
          },
          quantity: 1,
        },
      ],
      // metadata carries the user id through to the webhook, since
      // Stripe Checkout itself has no concept of your own user accounts
      metadata: { userId: String(req.user.id) },
      success_url: `${frontendUrl}/?founder=success`,
      cancel_url: `${frontendUrl}/?founder=cancelled`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Founder checkout error:', err.message);
    res.status(500).json({ error: 'Failed to start checkout — please try again.' });
  }
});

// ----------------------------------------------------------------
// POST /api/founder/webhook
// Stripe calls this when a checkout session completes. MUST receive
// the raw request body (not JSON-parsed) to verify the signature —
// see index.js, this route is mounted before express.json().
// ----------------------------------------------------------------
router.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Stripe webhook signature verification failed:', err.message);
    return res.status(400).json({ error: `Webhook signature verification failed` });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const userId = parseInt(session.metadata?.userId, 10);

    if (!userId) {
      console.error('Founder webhook: no userId in session metadata', session.id);
      return res.json({ received: true });
    }

    try {
      const { rows } = await pool.query(
        `UPDATE users
         SET founder_member = TRUE,
             founder_since = NOW(),
             membership_tier = 'founder',
             founder_payment_id = $1,
             founder_amount = $2
         WHERE id = $3 AND founder_member = FALSE
         RETURNING id, name, email`,
        [session.payment_intent, session.amount_total, userId]
      );

      // If no row came back, either the user was already a founder
      // (Stripe can resend webhook events — this makes it idempotent)
      // or the user id was invalid. Either way, nothing more to do.
      if (rows[0]) {
        await createNotification(pool, {
          userId,
          type: 'founder_welcome',
          title: '🏆 Welcome to the Founders Club!',
          body: 'Thank you for supporting Got One Spare — your Founder badge is now live on your profile.',
        }).catch(() => {});

        sendFounderWelcomeEmail(rows[0].email, rows[0].name).catch((err) => {
          console.error('Founder welcome email failed:', err.message);
        });
      }
    } catch (err) {
      console.error('Founder webhook DB update failed:', err.message);
      // Still acknowledge receipt so Stripe doesn't endlessly retry a
      // payment that DID succeed — log it and fix manually if needed.
    }
  }

  res.json({ received: true });
});

// ----------------------------------------------------------------
// Admin endpoints — deliberately self-contained here rather than in
// admin.js, so this feature doesn't risk touching that file. Uses
// the same x-admin-secret pattern as your other admin-gated routes.
// ----------------------------------------------------------------
function requireAdmin(req, res, next) {
  if (req.headers['x-admin-secret'] !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

// GET /api/founder/admin/list — everyone who's a Founder
router.get('/admin/list', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, email, founder_since, founder_amount, founder_payment_id, founder_notes
       FROM users WHERE founder_member = TRUE ORDER BY founder_since DESC`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load founders' });
  }
});

// POST /api/founder/admin/:userId/grant — manually grant, e.g. for a
// bank transfer or other off-platform payment
router.post('/admin/:userId/grant', requireAdmin, async (req, res) => {
  const { userId } = req.params;
  const { notes } = req.body || {};
  try {
    const { rows } = await pool.query(
      `UPDATE users SET founder_member = TRUE, founder_since = NOW(),
         membership_tier = 'founder', founder_notes = $1
       WHERE id = $2 RETURNING id, name`,
      [notes || 'Manually granted by admin', userId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json({ success: true, name: rows[0].name });
  } catch (err) {
    res.status(500).json({ error: 'Failed to grant founder status' });
  }
});

// POST /api/founder/admin/:userId/revoke
router.post('/admin/:userId/revoke', requireAdmin, async (req, res) => {
  const { userId } = req.params;
  try {
    const { rows } = await pool.query(
      `UPDATE users SET founder_member = FALSE, membership_tier = 'free'
       WHERE id = $1 RETURNING id, name`,
      [userId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json({ success: true, name: rows[0].name });
  } catch (err) {
    res.status(500).json({ error: 'Failed to revoke founder status' });
  }
});

module.exports = router;
