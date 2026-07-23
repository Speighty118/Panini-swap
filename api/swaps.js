/**
 * Swap API endpoints.
 *
 * Mount under /api/swaps in your main Express app:
 *   app.use('/api/swaps', require('./api/swaps'));
 *
 * Auth middleware (req.user) is assumed to run before these routes
 * and populate req.user.id with the authenticated user's id.
 */

const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const { requireAuth } = require('./middleware/auth');
const { createNotification } = require('./notifications');
const { sendPushNotification } = require('./push');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

router.use(requireAuth);

// ----------------------------------------------------------------
// GET /api/swaps/preview/:matchId
// Returns the proposed sticker list for a match WITHOUT creating
// a swap record. Lets users see what would be swapped before
// committing to a proposal.
// ----------------------------------------------------------------
router.get('/preview/:matchId', async (req, res) => {
  const userId = req.user.id;
  const { matchId } = req.params;
  try {
    const { rows: matchRows } = await pool.query(
      `SELECT * FROM matches WHERE id = $1 AND status = 'pending'`,
      [matchId]
    );
    const match = matchRows[0];
    if (!match) return res.status(404).json({ error: 'Match not found' });
    if (match.user_a_id !== userId && match.user_b_id !== userId) {
      return res.status(403).json({ error: 'Not your match' });
    }

    const { rows: allItems } = await pool.query(
      `SELECT gi.*, s.sticker_number, s.description, s.team_name
       FROM get_swap_proposal($1, $2, 5) gi
       JOIN stickers s ON s.id = gi.sticker_id`,
      [match.user_a_id, match.user_b_id]
    );

    const aToB = allItems.filter(i => i.from_user_id === match.user_a_id);
    const bToA = allItems.filter(i => i.from_user_id === match.user_b_id);
    const equalCount = Math.min(aToB.length, bToA.length);

    // Flag any sticker that either person has already committed in a
    // different swap that's still in progress — purely informational,
    // doesn't affect matching or availability at all.
    const { rows: committed } = await pool.query(
      `SELECT si.from_user_id, si.sticker_id, si.swap_id
       FROM swap_items si
       JOIN swaps s ON s.id = si.swap_id
       WHERE s.status IN ('proposed', 'accepted', 'posted')
         AND si.from_user_id IN ($1, $2)`,
      [match.user_a_id, match.user_b_id]
    );
    const committedMap = new Map();
    committed.forEach(c => committedMap.set(`${c.from_user_id}-${c.sticker_id}`, c.swap_id));

    // Separately flag any sticker either person is already due to
    // RECEIVE from a different in-progress swap — not a risk like the
    // above, just a heads-up that this need may already be covered.
    const { rows: incoming } = await pool.query(
      `SELECT si.to_user_id, si.sticker_id, si.swap_id
       FROM swap_items si
       JOIN swaps s ON s.id = si.swap_id
       WHERE s.status IN ('proposed', 'accepted', 'posted')
         AND si.to_user_id IN ($1, $2)`,
      [match.user_a_id, match.user_b_id]
    );
    const incomingMap = new Map();
    incoming.forEach(c => incomingMap.set(`${c.to_user_id}-${c.sticker_id}`, c.swap_id));

    const annotate = (item) => ({
      ...item,
      also_in_progress: committedMap.has(`${item.from_user_id}-${item.sticker_id}`),
      other_swap_id: committedMap.get(`${item.from_user_id}-${item.sticker_id}`) || null,
      already_receiving: incomingMap.has(`${item.to_user_id}-${item.sticker_id}`),
      already_receiving_swap_id: incomingMap.get(`${item.to_user_id}-${item.sticker_id}`) || null,
    });

    res.json({
      matchId: match.id,
      userAId: match.user_a_id,
      userBId: match.user_b_id,
      aGivesB: aToB.slice(0, equalCount).map(annotate),
      bGivesA: bToA.slice(0, equalCount).map(annotate),
      count: equalCount,
      predictedCount: equalCount,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to preview swap' });
  }
});

// ----------------------------------------------------------------
// GET /api/swaps/stats/:userId
// Reliability profile + swap statistics for a user — powers both
// the "reliability profile" shown on someone's ratings modal and
// the fuller "your stats" dashboard on your own profile. Built to
// be easy to extend with more fields later.
// ----------------------------------------------------------------
router.get('/stats/:userId', async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  if (!Number.isInteger(userId)) return res.status(400).json({ error: 'Invalid user id' });

  try {
    const { rows: userRows } = await pool.query(
      `SELECT id, name, city, profile_photo, ambassador_badge, rating_avg, rating_count, swap_streak, created_at, founder_member, founder_since, last_login_at FROM users WHERE id = $1`,
      [userId]
    );
    const user = userRows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });

    const { rows: swapRows } = await pool.query(
      `SELECT id, status, user_a_id, user_b_id, created_at, updated_at,
              user_a_accepted_at, user_b_accepted_at, user_a_posted_at, user_b_posted_at
       FROM swaps
       WHERE user_a_id = $1 OR user_b_id = $1`,
      [userId]
    );

    let completed = 0, committed = 0, active = 0;
    const responseDurationsMs = [];
    const dispatchDurationsMs = [];
    const completedDurationsMs = [];

    for (const s of swapRows) {
      const isUserA = s.user_a_id === userId;
      const myAcceptedAt = isUserA ? s.user_a_accepted_at : s.user_b_accepted_at;
      const myPostedAt = isUserA ? s.user_a_posted_at : s.user_b_posted_at;
      const wasCommitted = ['accepted', 'posted', 'completed'].includes(s.status);

      if (wasCommitted) committed++;
      if (['proposed', 'accepted', 'posted'].includes(s.status)) active++;
      if (s.status === 'completed') {
        completed++;
        completedDurationsMs.push(new Date(s.updated_at) - new Date(s.created_at));
      }
      if (myAcceptedAt) {
        responseDurationsMs.push(new Date(myAcceptedAt) - new Date(s.created_at));
      }
      if (myAcceptedAt && myPostedAt) {
        dispatchDurationsMs.push(new Date(myPostedAt) - new Date(myAcceptedAt));
      }
    }

    const avgMs = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
    const round1 = (n) => (n == null ? null : Math.round(n * 10) / 10);
    const msToHours = (ms) => (ms == null ? null : round1(ms / 3_600_000));
    const msToDays = (ms) => (ms == null ? null : round1(ms / 86_400_000));

    const { rows: exchRows } = await pool.query(
      `SELECT COUNT(*) FROM swap_items si
       JOIN swaps s ON s.id = si.swap_id
       WHERE s.status = 'completed' AND (si.from_user_id = $1 OR si.to_user_id = $1)`,
      [userId]
    );

    const { rows: needsRows } = await pool.query(
      `SELECT COUNT(*) FROM user_needs WHERE user_id = $1`,
      [userId]
    );

    res.json({
      userId: user.id,
      name: user.name,
      city: user.city,
      profilePhoto: user.profile_photo,
      ambassadorBadge: user.ambassador_badge,
      isFounder: Boolean(user.founder_member),
      founderSince: user.founder_since,
      lastLoginAt: user.last_login_at,
      ratingAvg: user.rating_avg,
      ratingCount: user.rating_count,
      memberSince: user.created_at,
      completedSwaps: completed,
      activeSwaps: active,
      successRatePct: committed > 0 ? round1((completed / committed) * 100) : null,
      stickersExchanged: parseInt(exchRows[0].count, 10),
      avgResponseHours: msToHours(avgMs(responseDurationsMs)),
      avgDispatchDays: msToDays(avgMs(dispatchDurationsMs)),
      fastestCompletedDays: completedDurationsMs.length ? msToDays(Math.min(...completedDurationsMs)) : null,
      longestCompletedDays: completedDurationsMs.length ? msToDays(Math.max(...completedDurationsMs)) : null,
      currentStreak: user.swap_streak || 0,
      needsRemaining: parseInt(needsRows[0].count, 10),
    });
  } catch (err) {
    console.error('Stats error:', err.message);
    res.status(500).json({ error: 'Failed to load stats' });
  }
});


router.get('/matches', async (req, res) => {
  const userId = req.user.id;
  try {
    const { rows } = await pool.query(
      `SELECT m.*,
              u.id AS other_user_id, u.name AS other_user_name, u.rating_avg, u.rating_count, u.ambassador_badge, u.founder_member, u.last_login_at,
              CASE
                WHEN me.postcode_latitude IS NOT NULL AND me.postcode_longitude IS NOT NULL
                 AND u.postcode_latitude IS NOT NULL AND u.postcode_longitude IS NOT NULL
                THEN ROUND((3959 * acos(LEAST(1, GREATEST(-1,
                       cos(radians(me.postcode_latitude)) * cos(radians(u.postcode_latitude)) *
                       cos(radians(u.postcode_longitude) - radians(me.postcode_longitude)) +
                       sin(radians(me.postcode_latitude)) * sin(radians(u.postcode_latitude))
                     ))))::numeric, 1)
                ELSE NULL
              END AS distance_miles
       FROM matches m
       JOIN users u ON u.id = CASE WHEN m.user_a_id = $1 THEN m.user_b_id ELSE m.user_a_id END
       JOIN users me ON me.id = $1
       WHERE (m.user_a_id = $1 OR m.user_b_id = $1)
         AND m.status = 'pending'
         AND COALESCE(me.matching_paused, FALSE) = FALSE
         AND COALESCE(u.matching_paused, FALSE) = FALSE
       ORDER BY m.computed_at DESC`,
      [userId]
    );

    // Flag matches where some of the stock either side would give is already
    // committed to a different active swap — read-only, informational only.
    // Same check the preview screen already runs, just surfaced earlier so
    // users see it before opening a preview. Doesn't touch matching or
    // inventory in any way.
    for (const m of rows) {
      const { rows: conflictRows } = await pool.query(
        `SELECT 1
         FROM get_swap_proposal($1, $2, 5) gi
         JOIN swap_items si ON si.sticker_id = gi.sticker_id AND si.from_user_id = gi.from_user_id
         JOIN swaps s ON s.id = si.swap_id
         WHERE s.status IN ('proposed', 'accepted', 'posted')
         LIMIT 1`,
        [m.user_a_id, m.user_b_id]
      );
      m.has_conflict = conflictRows.length > 0;
    }

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch matches' });
  }
});

// ----------------------------------------------------------------
// GET /api/swaps/history
// Completed and declined swaps — the user's swap history.
// ----------------------------------------------------------------
router.get('/history', async (req, res) => {
  const userId = req.user.id;
  try {
    const { rows } = await pool.query(
      `SELECT s.*,
              u.id AS other_user_id, u.name AS other_user_name, u.ambassador_badge, u.founder_member, u.last_login_at,
              (SELECT COUNT(*) FROM swap_items WHERE swap_id = s.id AND from_user_id = $1) AS you_gave_count,
              (SELECT COUNT(*) FROM swap_items WHERE swap_id = s.id AND to_user_id = $1) AS you_got_count,
              r.stars AS your_rating
       FROM swaps s
       JOIN users u ON u.id = CASE WHEN s.user_a_id = $1 THEN s.user_b_id ELSE s.user_a_id END
       LEFT JOIN ratings r ON r.swap_id = s.id AND r.rater_id = $1
       WHERE (s.user_a_id = $1 OR s.user_b_id = $1)
         AND s.status IN ('completed', 'declined')
       ORDER BY s.updated_at DESC`,
      [userId]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch swap history' });
  }
});

// ----------------------------------------------------------------
// GET /api/swaps/mines
// List every swap the logged-in user is part of, any status,
// most recently updated first — lets someone revisit a past or
// completed swap once it's no longer on the Matches tab.
// ----------------------------------------------------------------
router.get('/mine', async (req, res) => {
  const userId = req.user.id;
  try {
    const { rows } = await pool.query(
      `SELECT s.*,
              u.id AS other_user_id, u.name AS other_user_name, u.ambassador_badge, u.founder_member, u.last_login_at,
              COALESCE((SELECT COUNT(*) FROM swap_items WHERE swap_id = s.id AND from_user_id = $1), 0) AS you_give_count,
              COALESCE((SELECT COUNT(*) FROM swap_items WHERE swap_id = s.id AND to_user_id = $1), 0) AS you_get_count,
              CASE WHEN (SELECT COUNT(*) FROM swap_items WHERE swap_id = s.id) > 0
                THEN (SELECT COUNT(*) FROM swap_items WHERE swap_id = s.id AND from_user_id = $1)
                ELSE s.predicted_count
              END AS display_give_count,
              CASE WHEN (SELECT COUNT(*) FROM swap_items WHERE swap_id = s.id) > 0
                THEN (SELECT COUNT(*) FROM swap_items WHERE swap_id = s.id AND to_user_id = $1)
                ELSE s.predicted_count
              END AS display_get_count
       FROM swaps s
       JOIN users u ON u.id = CASE WHEN s.user_a_id = $1 THEN s.user_b_id ELSE s.user_a_id END
       WHERE s.user_a_id = $1 OR s.user_b_id = $1
       ORDER BY s.updated_at DESC`,
      [userId]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch your swaps' });
  }
});

// ----------------------------------------------------------------
// POST /api/swaps
// Create a swap proposal from a match. Body: { matchId }
// Stickers are locked in at proposal time so users see the exact
// list. The double-booking trigger prevents the same sticker
// appearing in two concurrent swaps. When a swap completes, any
// other proposed swaps containing those stickers are auto-declined.
// ----------------------------------------------------------------
router.post('/', async (req, res) => {
  const userId = req.user.id;
  const { matchId } = req.body;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: userRows } = await client.query('SELECT email_verified, is_suspended FROM users WHERE id = $1', [userId]);
    if (userRows[0]?.is_suspended) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Your account has been suspended. Contact the group admin for details.' });
    }
    if (!userRows[0]?.email_verified) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Please verify your email before starting a swap. Check your inbox or request a new link from your profile.' });
    }

    const { rows: matchRows } = await client.query(
      `SELECT * FROM matches WHERE id = $1 AND status = 'pending'`,
      [matchId]
    );
    const match = matchRows[0];
    if (!match) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Match not found or already actioned' });
    }
    if (match.user_a_id !== userId && match.user_b_id !== userId) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Not your match' });
    }

    // Get the current sticker list
    const { rows: allItems } = await client.query(
      `SELECT * FROM get_swap_proposal($1, $2, 5)`,
      [match.user_a_id, match.user_b_id]
    );
    const aToB = allItems.filter(i => i.from_user_id === match.user_a_id);
    const bToA = allItems.filter(i => i.from_user_id === match.user_b_id);
    const equalCount = Math.min(aToB.length, bToA.length);
    const items = [...aToB.slice(0, equalCount), ...bToA.slice(0, equalCount)];

    const MIN_STICKERS = 3;
    if (equalCount < MIN_STICKERS) {
      await client.query(`UPDATE matches SET status = 'stale' WHERE id = $1`, [matchId]);
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'This match is no longer valid — sticker availability has changed. It has been refreshed and a new match will appear within a minute.',
        stale: true,
      });
    }

    // Create the swap record with predicted count for display
    const { rows: swapRows } = await client.query(
      `INSERT INTO swaps (user_a_id, user_b_id, status, predicted_count)
       VALUES ($1, $2, 'proposed', $3)
       RETURNING *`,
      [match.user_a_id, match.user_b_id, equalCount]
    );
    const swap = swapRows[0];

    // Lock in the sticker list immediately so users see the exact stickers
    for (const item of items) {
      await client.query(
        `INSERT INTO swap_items (swap_id, sticker_id, from_user_id, to_user_id)
         VALUES ($1, $2, $3, $4)`,
        [swap.id, item.sticker_id, item.from_user_id, item.to_user_id]
      ).catch(async (err) => {
        if (err.message?.includes('already committed') || err.code === '23505') {
          throw Object.assign(new Error('One or more stickers are already committed to another active swap. Please wait for that swap to complete or be declined before proposing a new one.'), { doubleBooked: true });
        }
        throw err;
      });
    }

    await client.query(`UPDATE matches SET status = 'proposed' WHERE id = $1`, [matchId]);
    await client.query('COMMIT');

    // Notify the other party
    const { rows: proposerRows } = await pool.query('SELECT name FROM users WHERE id = $1', [userId]);
    const otherUserId = swap.user_a_id === userId ? swap.user_b_id : swap.user_a_id;
    await createNotification(pool, {
      userId: otherUserId,
      type: 'swap_proposed',
      title: `${proposerRows[0]?.name || 'Someone'} proposed a swap`,
      body: 'Check your matches to accept or decline.',
      swapId: swap.id,
    });

    // Push notification
    sendPushNotification(otherUserId, {
      title: '🤝 New swap proposal!',
      body: `${proposerRows[0]?.name || 'Someone'} wants to swap stickers with you`,
    }).catch(() => {});

    res.status(201).json({ swap, items });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.doubleBooked) {
      return res.status(409).json({ error: err.message, doubleBooked: true });
    }
    console.error(err);
    res.status(500).json({ error: 'Failed to create swap' });
  } finally {
    client.release();
  }
});

// ----------------------------------------------------------------
// GET /api/swaps/:id
// Full swap detail including items. Addresses only included
// if status is 'accepted' or later AND requester is a participant.
// ----------------------------------------------------------------
router.get('/:id', async (req, res) => {
  const userId = req.user.id;
  const swapId = req.params.id;

  try {
    const { rows: swapRows } = await pool.query(
      `SELECT * FROM swaps WHERE id = $1`,
      [swapId]
    );
    const swap = swapRows[0];
    if (!swap) return res.status(404).json({ error: 'Swap not found' });
    if (swap.user_a_id !== userId && swap.user_b_id !== userId) {
      return res.status(403).json({ error: 'Not your swap' });
    }

    const { rows: rawItems } = await pool.query(
      `SELECT si.*, s.sticker_number, s.description, s.team_name
       FROM swap_items si
       JOIN stickers s ON s.id = si.sticker_id
       WHERE si.swap_id = $1`,
      [swapId]
    );

    // Flag any sticker either person has separately committed in a
    // different swap that's still in progress — informational only.
    const { rows: committed } = await pool.query(
      `SELECT si.from_user_id, si.sticker_id, si.swap_id
       FROM swap_items si
       JOIN swaps s ON s.id = si.swap_id
       WHERE s.status IN ('proposed', 'accepted', 'posted')
         AND si.swap_id != $1
         AND si.from_user_id IN ($2, $3)`,
      [swapId, swap.user_a_id, swap.user_b_id]
    );
    const committedMap = new Map();
    committed.forEach(c => committedMap.set(`${c.from_user_id}-${c.sticker_id}`, c.swap_id));

    // Separately flag any sticker either person is already due to
    // RECEIVE from a different in-progress swap — a heads-up, not a
    // risk, since this need may already be covered elsewhere.
    const { rows: incoming } = await pool.query(
      `SELECT si.to_user_id, si.sticker_id, si.swap_id
       FROM swap_items si
       JOIN swaps s ON s.id = si.swap_id
       WHERE s.status IN ('proposed', 'accepted', 'posted')
         AND si.swap_id != $1
         AND si.to_user_id IN ($2, $3)`,
      [swapId, swap.user_a_id, swap.user_b_id]
    );
    const incomingMap = new Map();
    incoming.forEach(c => incomingMap.set(`${c.to_user_id}-${c.sticker_id}`, c.swap_id));

    const items = rawItems.map(item => ({
      ...item,
      also_in_progress: committedMap.has(`${item.from_user_id}-${item.sticker_id}`),
      other_swap_id: committedMap.get(`${item.from_user_id}-${item.sticker_id}`) || null,
      already_receiving: incomingMap.has(`${item.to_user_id}-${item.sticker_id}`),
      already_receiving_swap_id: incomingMap.get(`${item.to_user_id}-${item.sticker_id}`) || null,
    }));

    const bothAccepted = swap.user_a_accepted && swap.user_b_accepted;
    let addresses = null;
    const otherUserId = swap.user_a_id === userId ? swap.user_b_id : swap.user_a_id;

    const { rows: otherUserRows } = await pool.query(
      `SELECT id, name, ambassador_badge, founder_member, last_login_at FROM users WHERE id = $1`,
      [otherUserId]
    );
    const otherUser = otherUserRows[0];

    if (bothAccepted) {
      const { rows: addrRows } = await pool.query(
        `SELECT name, address_line1, address_line2, city, postcode, country
         FROM users WHERE id = $1`,
        [otherUserId]
      );
      addresses = addrRows[0];
    }

    res.json({ swap, items, otherUserAddress: addresses, otherUser });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch swap' });
  }
});

// ----------------------------------------------------------------
// POST /api/swaps/:id/accept
// Mark this user's side as accepted. When BOTH sides have accepted,
// the sticker list is calculated from current availability RIGHT NOW
// and locked in. This is the architectural fix — stickers are never
// committed until both parties have confirmed.
// ----------------------------------------------------------------
router.post('/:id/accept', async (req, res) => {
  const userId = req.user.id;
  const swapId = req.params.id;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(`SELECT * FROM swaps WHERE id = $1`, [swapId]);
    const swap = rows[0];
    if (!swap) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Swap not found' });
    }
    if (swap.user_a_id !== userId && swap.user_b_id !== userId) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Not your swap' });
    }

    const isUserA = swap.user_a_id === userId;
    const field = isUserA ? 'user_a_accepted' : 'user_b_accepted';

    // Verify this user still has all stickers they need to give.
    // If any are missing, auto-decline with a friendly message.
    const { rows: itemsToGive } = await client.query(
      `SELECT si.sticker_id, s.sticker_number FROM swap_items si
       JOIN stickers s ON s.id = si.sticker_id
       WHERE si.swap_id = $1 AND si.from_user_id = $2`,
      [swapId, userId]
    );

    for (const item of itemsToGive) {
      const { rows: dupeRows } = await client.query(
        `SELECT 1 FROM user_duplicates WHERE user_id = $1 AND sticker_id = $2`,
        [userId, item.sticker_id]
      );
      if (!dupeRows.length) {
        // Auto-decline cleanly
        await client.query(
          `UPDATE swaps SET status = 'declined',
           decline_reason = 'Automatically declined — some stickers were no longer available. A fresh match will be generated shortly.',
           updated_at = NOW() WHERE id = $1`,
          [swapId]
        );
        await client.query('COMMIT');
        const otherUserId = swap.user_a_id === userId ? swap.user_b_id : swap.user_a_id;
        await pool.query(
          `INSERT INTO notifications (user_id, type, title, body)
           VALUES ($1, 'swap_declined', 'Swap automatically cancelled', 'A swap was cancelled because some stickers were no longer available. A fresh match will appear in your Matches tab shortly.')`,
          [otherUserId]
        ).catch(() => {});
        return res.status(409).json({
          error: 'This swap has been automatically cancelled — some stickers were no longer available. A fresh match will appear in your Matches tab within a minute.',
          autoDeclined: true,
        });
      }
    }

    // Mark this user's side as accepted
    await client.query(
      `UPDATE swaps SET ${field} = TRUE, ${field}_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [swapId]
    );

    const { rows: updatedRows } = await client.query(`SELECT * FROM swaps WHERE id = $1`, [swapId]);
    const updated = updatedRows[0];

    // If both sides have now accepted, calculate the sticker list RIGHT NOW
    // from current availability and lock it in. This is the key architectural
    // change — stickers are only committed when both parties confirm.
    if (updated.user_a_accepted && updated.user_b_accepted && updated.status === 'proposed') {

      // Stickers were locked in at proposal time — just fetch and process them
      const { rows: items } = await client.query(
        `SELECT sticker_id, from_user_id, to_user_id FROM swap_items WHERE swap_id = $1`,
        [swapId]
      );

      // Mark swap as fully accepted
      await client.query(
        `UPDATE swaps SET status = 'accepted', updated_at = NOW() WHERE id = $1`,
        [swapId]
      );

      // Remove stickers from duplicates/needs now they're committed
      const committedStickerIds = [];
      for (const item of items) {
        committedStickerIds.push(item.sticker_id);
        // Delete directly if only 1 copy — avoids the user_duplicates_quantity_check
        // constraint which prevents quantity going to 0 via UPDATE.
        await client.query(
          `DELETE FROM user_duplicates
           WHERE user_id = $1 AND sticker_id = $2 AND quantity <= 1`,
          [item.from_user_id, item.sticker_id]
        );
        // Decrement if they had more than 1 copy
        await client.query(
          `UPDATE user_duplicates SET quantity = quantity - 1
           WHERE user_id = $1 AND sticker_id = $2 AND quantity > 1`,
          [item.from_user_id, item.sticker_id]
        );
        await client.query(
          `DELETE FROM user_needs WHERE user_id = $1 AND sticker_id = $2`,
          [item.to_user_id, item.sticker_id]
        );
      }

      // Auto-decline any OTHER proposed swaps that contain the same stickers
      // now that those stickers have been removed from user_duplicates.
      // This prevents users from seeing "failed to accept" on other swaps.
      if (committedStickerIds.length > 0) {
        await client.query(
          `UPDATE swaps SET status = 'declined',
             decline_reason = 'Automatically declined — some stickers were committed to another swap that completed. A fresh match will be generated shortly.',
             updated_at = NOW()
           WHERE status = 'proposed'
             AND id != $1
             AND id IN (
               SELECT DISTINCT swap_id FROM swap_items
               WHERE sticker_id = ANY($2::integer[])
                 AND from_user_id IN ($3, $4)
             )`,
          [swapId, committedStickerIds, updated.user_a_id, updated.user_b_id]
        );
      }

      // Award verified postage badge if applicable
      const { awardBadge } = require('./badges');
      awardBadge(userId, 'first_swap').catch(() => {});

      // Notify both parties
      const { rows: userRows } = await pool.query('SELECT name FROM users WHERE id = $1', [userId]);
      const otherUserId = updated.user_a_id === userId ? updated.user_b_id : updated.user_a_id;
      await createNotification(pool, {
        userId: otherUserId,
        type: 'swap_accepted',
        title: 'Swap accepted — time to post!',
        body: `${userRows[0]?.name || 'Your swap partner'} also accepted. Check the swap for their address.`,
        swapId,
      });

      // Push notification
      sendPushNotification(otherUserId, {
        title: '🎉 Swap accepted!',
        body: `${userRows[0]?.name || 'Your swap partner'} accepted — time to post!`,
      }).catch(() => {});
    }

    await client.query('COMMIT');

    // If fully accepted, mark other pending matches for both users as stale
    if (updated.user_a_accepted && updated.user_b_accepted) {
      pool.query(
        `UPDATE matches SET status = 'stale'
         WHERE status = 'pending'
           AND (user_a_id = $1 OR user_b_id = $1 OR user_a_id = $2 OR user_b_id = $2)`,
        [updated.user_a_id, updated.user_b_id]
      ).catch(() => {});
    }

    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`[ACCEPT SWAP ERROR] swapId=${swapId} userId=${userId} message=${err.message} code=${err.code} detail=${err.detail || ''}`);
    res.status(500).json({ error: 'Failed to accept swap' });
  } finally {
    client.release();
  }
});

// ----------------------------------------------------------------
// POST /api/swaps/:id/decline
// Either side can decline while still in 'proposed' state.
// Body: { reason? } — optional free-text reason shown to other party.
// ----------------------------------------------------------------
router.post('/:id/decline', async (req, res) => {
  const userId = req.user.id;
  const swapId = req.params.id;
  const { reason } = req.body;

  try {
    const { rows } = await pool.query(
      `SELECT s.*, ua.name AS user_a_name, ub.name AS user_b_name
       FROM swaps s
       JOIN users ua ON ua.id = s.user_a_id
       JOIN users ub ON ub.id = s.user_b_id
       WHERE s.id = $1`,
      [swapId]
    );
    const swap = rows[0];
    if (!swap) return res.status(404).json({ error: 'Swap not found' });
    if (swap.user_a_id !== userId && swap.user_b_id !== userId) {
      return res.status(403).json({ error: 'Not your swap' });
    }
    if (swap.status !== 'proposed') {
      return res.status(400).json({ error: 'Swap already past the proposal stage' });
    }

    const declinerName = userId === swap.user_a_id ? swap.user_a_name : swap.user_b_name;
    const otherUserId = userId === swap.user_a_id ? swap.user_b_id : swap.user_a_id;

    await pool.query(
      `UPDATE swaps
       SET status = 'declined', updated_at = NOW(),
           declined_by_id = $1, decline_reason = $2
       WHERE id = $3`,
      [userId, reason?.trim() || null, swapId]
    );

    // Notify the other party with the reason if one was given
    const notifBody = reason?.trim()
      ? `${declinerName} declined your swap and said: "${reason.trim()}"`
      : `${declinerName} has declined your swap proposal.`;

    await pool.query(
      `INSERT INTO notifications (user_id, type, title, body)
       VALUES ($1, 'swap_declined', $2, $3)`,
      [otherUserId, 'Swap declined', notifBody]
    ).catch(() => {});

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to decline swap' });
  }
});

// ----------------------------------------------------------------
// POST /api/swaps/:id/withdraw
// Withdraw from a swap in one of two stages:
//   - 'proposed', with at most one side having accepted so far (once both
//     have accepted the swap is binding).
//   - 'accepted', but only before either side has posted. Accepting removes
//     the swapped stickers from both users' duplicates/needs immediately, so
//     withdrawing here has to restore them — otherwise they'd just vanish
//     from both accounts. Once either side has posted, this is blocked and
//     the dispute process takes over instead — real stickers are in transit.
// ----------------------------------------------------------------
router.post('/:id/withdraw', async (req, res) => {
  const userId = req.user.id;
  const swapId = req.params.id;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `SELECT s.*, ua.name AS user_a_name, ub.name AS user_b_name
       FROM swaps s
       JOIN users ua ON ua.id = s.user_a_id
       JOIN users ub ON ub.id = s.user_b_id
       WHERE s.id = $1`,
      [swapId]
    );
    const swap = rows[0];
    if (!swap) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Swap not found' });
    }
    if (swap.user_a_id !== userId && swap.user_b_id !== userId) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Not your swap' });
    }

    const isAcceptedStage = swap.status === 'accepted' && !swap.user_a_posted && !swap.user_b_posted;

    if (swap.status === 'proposed') {
      // Block if both have already accepted — swap is binding at that point
      if (swap.user_a_accepted && swap.user_b_accepted) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Both sides have already accepted — the swap is binding. Use the dispute process if there is a problem.' });
      }
    } else if (!isAcceptedStage) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: swap.status === 'accepted'
          ? 'You can only withdraw before either side has posted. Once stickers are in the post, use the dispute process instead.'
          : 'This swap can no longer be withdrawn from.',
      });
    }

    const withdrawerName = userId === swap.user_a_id ? swap.user_a_name : swap.user_b_name;
    const otherUserId = userId === swap.user_a_id ? swap.user_b_id : swap.user_a_id;

    // Accepting removed these stickers from user_duplicates/user_needs —
    // put them back before declining, so nothing just disappears.
    if (isAcceptedStage) {
      const { rows: items } = await client.query(
        `SELECT sticker_id, from_user_id, to_user_id FROM swap_items WHERE swap_id = $1`,
        [swapId]
      );
      for (const item of items) {
        await client.query(
          `INSERT INTO user_duplicates (user_id, sticker_id, quantity)
           VALUES ($1, $2, 1)
           ON CONFLICT (user_id, sticker_id) DO UPDATE SET quantity = user_duplicates.quantity + 1`,
          [item.from_user_id, item.sticker_id]
        );
        await client.query(
          `INSERT INTO user_needs (user_id, sticker_id)
           VALUES ($1, $2)
           ON CONFLICT (user_id, sticker_id) DO NOTHING`,
          [item.to_user_id, item.sticker_id]
        );
      }
    }

    // Mark as declined (reuse declined status — withdraw is a soft decline)
    await client.query(
      `UPDATE swaps SET status = 'declined', updated_at = NOW(),
       declined_by_id = $1, decline_reason = $2
       WHERE id = $3`,
      [userId, isAcceptedStage ? 'Withdrawn after acceptance' : 'Withdrawn by proposer', swapId]
    );

    await client.query('COMMIT');

    // Notify the other party
    await pool.query(
      `INSERT INTO notifications (user_id, type, title, body)
       VALUES ($1, 'swap_declined', $2, $3)`,
      [
        otherUserId,
        'Swap withdrawn',
        isAcceptedStage
          ? `${withdrawerName} has withdrawn from your accepted swap before posting. Your stickers are available for new matches.`
          : `${withdrawerName} has withdrawn from your swap. Your stickers are available for new matches.`,
      ]
    ).catch(() => {});

    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed to withdraw from swap' });
  } finally {
    client.release();
  }
});

// ----------------------------------------------------------------
// POST /api/swaps/:id/sticker-photo
// Upload a photo of the stickers you're about to send.
// Shows on both sides of the swap as pre-posting evidence.
// Body: { photo } — base64 image string.
// ----------------------------------------------------------------
router.post('/:id/sticker-photo', async (req, res) => {
  const userId = req.user.id;
  const swapId = parseInt(req.params.id);
  const { photo } = req.body;

  if (!photo) return res.status(400).json({ error: 'Photo is required' });
  if (photo.length > 7_000_000) return res.status(400).json({ error: 'Photo too large — please use a smaller image' });

  try {
    const { rows } = await pool.query(`SELECT * FROM swaps WHERE id = $1`, [swapId]);
    if (!rows[0]) return res.status(404).json({ error: 'Swap not found' });
    const swap = rows[0];

    if (swap.user_a_id !== userId && swap.user_b_id !== userId) {
      return res.status(403).json({ error: 'Not your swap' });
    }
    if (!['accepted', 'posted'].includes(swap.status)) {
      return res.status(400).json({ error: 'Swap is not in an active state' });
    }

    const isUserA = swap.user_a_id === userId;
    const field = isUserA ? 'user_a_sticker_photo' : 'user_b_sticker_photo';

    await pool.query(
      `UPDATE swaps SET ${field} = $1, updated_at = NOW() WHERE id = $2`,
      [photo, swapId]
    );

    // Notify the other side
    const otherUserId = isUserA ? swap.user_b_id : swap.user_a_id;
    const { rows: senderRows } = await pool.query('SELECT name FROM users WHERE id = $1', [userId]);
    await createNotification(pool, {
      userId: otherUserId,
      type: 'sticker_photo',
      title: 'Sticker photo shared',
      body: `${senderRows[0]?.name || 'Your swap partner'} has shared a photo of the stickers they're sending you.`,
      swapId,
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Sticker photo error:', err.message);
    res.status(500).json({ error: 'Failed to save photo' });
  }
});

// ----------------------------------------------------------------
// POST /api/swaps/:id/posted
// Mark this user's side as having posted their stickers.
// Body: { photo? } — optional base64 image as proof of postage.
// ----------------------------------------------------------------
router.post('/:id/posted', async (req, res) => {
  const userId = req.user.id;
  const swapId = req.params.id;
  const { photo } = req.body;

  // Basic validation if photo provided — must be a base64 data URL
  if (photo && !photo.startsWith('data:image/')) {
    return res.status(400).json({ error: 'Invalid photo format' });
  }
  // Limit photo size to ~5MB base64
  if (photo && photo.length > 7_000_000) {
    return res.status(400).json({ error: 'Photo too large — please use a smaller image' });
  }

  try {
    const { rows } = await pool.query(`SELECT * FROM swaps WHERE id = $1`, [swapId]);
    const swap = rows[0];
    if (!swap) return res.status(404).json({ error: 'Swap not found' });
    if (swap.user_a_id !== userId && swap.user_b_id !== userId) {
      return res.status(403).json({ error: 'Not your swap' });
    }
    if (!['accepted', 'posted'].includes(swap.status)) {
      return res.status(400).json({ error: 'Swap must be accepted before posting' });
    }

    const isUserA = swap.user_a_id === userId;
    const field = isUserA ? 'user_a_posted' : 'user_b_posted';
    const otherPostedField = isUserA ? 'user_b_posted' : 'user_a_posted';
    const photoField = isUserA ? 'user_a_postage_photo' : 'user_b_postage_photo';

    // Store photo on this user's own column and mark their side as posted —
    // previously both sides wrote to the same shared `postage_photo` column,
    // so whoever posted second silently overwrote the first person's photo.
    if (photo) {
      await pool.query(
        `UPDATE swaps SET ${field} = TRUE, ${field}_at = NOW(), ${photoField} = $1, updated_at = NOW() WHERE id = $2`,
        [photo, swapId]
      );
    } else {
      await pool.query(
        `UPDATE swaps SET ${field} = TRUE, ${field}_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [swapId]
      );
    }

    // If the other side has already posted too, advance status to 'posted'
    if (swap[otherPostedField]) {
      await pool.query(
        `UPDATE swaps SET status = 'posted', updated_at = NOW() WHERE id = $1`,
        [swapId]
      );
    }

    // Award verified postage badge + XP if photo was provided
    if (photo) {
      const { awardBadge } = require('./badges');
      awardBadge(userId, 'verified_postage').catch(() => {});
      const { awardXp } = require('./xp');
      awardXp(pool, { userId, eventType: 'verified_postage', relatedId: swapId }).catch(() => {});
    }

    // Notify the other party
    const { rows: senderRows } = await pool.query('SELECT name FROM users WHERE id = $1', [userId]);
    const otherUserId = isUserA ? swap.user_b_id : swap.user_a_id;
    await createNotification(pool, {
      userId: otherUserId,
      type: 'swap_posted',
      title: 'Stickers on their way!',
      body: `${senderRows[0]?.name || 'Your swap partner'} has posted their stickers${photo ? ' and uploaded proof of postage' : ''}.`,
      swapId,
    });

    // Push notification
    sendPushNotification(otherUserId, {
      title: '📮 Stickers posted!',
      body: `${senderRows[0]?.name || 'Your swap partner'} has posted their stickers`,
    }).catch(() => {});

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update posted status' });
  }
});

// ----------------------------------------------------------------
// POST /api/swaps/:id/received
// Mark this user's side as having received the other's stickers.
// If both sides confirm, swap moves to 'completed' and removes
// the swapped stickers from each user's duplicates/needs lists.
// ----------------------------------------------------------------
router.post('/:id/received', async (req, res) => {
  const userId = req.user.id;
  const swapId = req.params.id;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(`SELECT * FROM swaps WHERE id = $1`, [swapId]);
    const swap = rows[0];
    if (!swap) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Swap not found' });
    }
    if (swap.user_a_id !== userId && swap.user_b_id !== userId) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Not your swap' });
    }

    const isUserA = swap.user_a_id === userId;
    const field = isUserA ? 'user_a_received' : 'user_b_received';

    await client.query(
      `UPDATE swaps SET ${field} = TRUE, updated_at = NOW() WHERE id = $1`,
      [swapId]
    );

    const { rows: updatedRows } = await client.query(`SELECT * FROM swaps WHERE id = $1`, [swapId]);
    const updated = updatedRows[0];

    // Only mark as completed when BOTH sides have confirmed receipt
    if (updated.user_a_received && updated.user_b_received) {
      await client.query(
        `UPDATE swaps SET status = 'completed', updated_at = NOW() WHERE id = $1`,
        [swapId]
      );
    }

    await client.query('COMMIT');

    // Award badges + XP after commit — fire and forget
    if (updated.user_a_received && updated.user_b_received) {
      const { checkStreakBadges, updateResponseRate } = require('./badges');
      checkStreakBadges(updated.user_a_id).catch(() => {});
      checkStreakBadges(updated.user_b_id).catch(() => {});
      updateResponseRate(updated.user_a_id).catch(() => {});
      updateResponseRate(updated.user_b_id).catch(() => {});

      const { awardXp } = require('./xp');
      for (const uid of [updated.user_a_id, updated.user_b_id]) {
        awardXp(pool, { userId: uid, eventType: 'completed_swap', relatedId: swapId }).catch(() => {});
        awardXp(pool, { userId: uid, eventType: 'first_swap_bonus' }).catch(() => {});
      }

      // Pay out the referrer's bonus once their referral proves real —
      // keyed on the referred user's own id (not the swap), so this
      // only ever pays once per referral relationship no matter how
      // many swaps that person goes on to complete.
      pool.query(
        `SELECT id, referred_by_user_id FROM users WHERE id = ANY($1::int[]) AND referred_by_user_id IS NOT NULL`,
        [[updated.user_a_id, updated.user_b_id]]
      ).then(({ rows: referred }) => {
        for (const r of referred) {
          awardXp(pool, { userId: r.referred_by_user_id, eventType: 'referral_bonus', relatedId: r.id }).catch(() => {});
        }
      }).catch(() => {});
    }

    // Notify the other party that stickers were received
    const { rows: receiverRows } = await pool.query('SELECT name FROM users WHERE id = $1', [userId]);
    const otherUserId = isUserA ? updated.user_b_id : updated.user_a_id;

    // Push notification
    sendPushNotification(otherUserId, {
      title: '📦 Stickers received!',
      body: `${receiverRows[0]?.name || 'Your swap partner'} confirmed they got their stickers`,
    }).catch(() => {});

    // Always return canRate: true so the rating prompt shows immediately
    // when the user marks received — they have the stickers so they can rate
    res.json({ success: true, completed: updated.user_a_received && updated.user_b_received, canRate: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed to update received status' });
  } finally {
    client.release();
  }
});

module.exports = router;
