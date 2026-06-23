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

    res.json({
      matchId: match.id,
      userAId: match.user_a_id,
      userBId: match.user_b_id,
      aGivesB: aToB.slice(0, equalCount),
      bGivesA: bToA.slice(0, equalCount),
      count: equalCount,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to preview swap' });
  }
});

// ----------------------------------------------------------------
// GET /api/swaps/matches
// List this user's pending match candidates (not yet a swap).
// ----------------------------------------------------------------
router.get('/matches', async (req, res) => {
  const userId = req.user.id;
  try {
    const { rows } = await pool.query(
      `SELECT m.*, 
              u.id AS other_user_id, u.name AS other_user_name, u.rating_avg, u.rating_count
       FROM matches m
       JOIN users u ON u.id = CASE WHEN m.user_a_id = $1 THEN m.user_b_id ELSE m.user_a_id END
       WHERE (m.user_a_id = $1 OR m.user_b_id = $1)
         AND m.status = 'pending'
       ORDER BY m.computed_at DESC`,
      [userId]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch matches' });
  }
});

// ----------------------------------------------------------------
// GET /api/swaps/mine
// List every swap the logged-in user is part of, any status,
// most recently updated first — lets someone revisit a past or
// completed swap once it's no longer on the Matches tab.
// ----------------------------------------------------------------
router.get('/mine', async (req, res) => {
  const userId = req.user.id;
  try {
    const { rows } = await pool.query(
      `SELECT s.*,
              u.id AS other_user_id, u.name AS other_user_name,
              (SELECT COUNT(*) FROM swap_items WHERE swap_id = s.id AND from_user_id = $1) AS you_give_count,
              (SELECT COUNT(*) FROM swap_items WHERE swap_id = s.id AND to_user_id = $1) AS you_get_count
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
// Pulls the actual sticker list via get_swap_proposal() and
// inserts swap + swap_items rows.
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

    const { rows: swapRows } = await client.query(
      `INSERT INTO swaps (user_a_id, user_b_id, status)
       VALUES ($1, $2, 'proposed')
       RETURNING *`,
      [match.user_a_id, match.user_b_id]
    );
    const swap = swapRows[0];

    const { rows: allItems } = await client.query(
      `SELECT * FROM get_swap_proposal($1, $2, 5)`,
      [match.user_a_id, match.user_b_id]
    );

    // Enforce equal swap: trim both sides to the smaller count so
    // neither party gives more than they receive. This is the 1-for-1
    // philosophy — every sticker has equal value regardless of player.
    const aToB = allItems.filter(i => i.from_user_id === match.user_a_id);
    const bToA = allItems.filter(i => i.from_user_id === match.user_b_id);
    const equalCount = Math.min(aToB.length, bToA.length);
    const items = [...aToB.slice(0, equalCount), ...bToA.slice(0, equalCount)];

    // Option B duplicate check: before committing, verify none of these
    // stickers are already part of an active pending/accepted swap for
    // EITHER user — not just the proposer. This prevents both sides from
    // accidentally double-promising the same sticker.
    const proposalStickerIds = items.map(i => i.sticker_id);
    if (proposalStickerIds.length > 0) {
      const { rows: conflicts } = await client.query(
        `SELECT si.sticker_id, s.sticker_number, s.description,
                sw.id AS conflicting_swap_id,
                si.from_user_id AS committed_by
         FROM swap_items si
         JOIN swaps sw ON sw.id = si.swap_id
         JOIN stickers s ON s.id = si.sticker_id
         WHERE sw.status IN ('proposed', 'accepted')
           AND sw.id != $1
           AND si.sticker_id = ANY($2::int[])
           AND si.from_user_id IN ($3, $4)`,
        [swap.id, proposalStickerIds, match.user_a_id, match.user_b_id]
      );
      if (conflicts.length > 0) {
        await client.query('ROLLBACK');
        const names = conflicts.map(c => `${c.sticker_number} (${c.description})`).join(', ');
        return res.status(409).json({
          error: `Some stickers in this swap are already committed to another pending swap: ${names}. The existing swap needs to be accepted or declined before a new one can be proposed with the same stickers.`,
          conflicts: conflicts.map(c => ({ stickerId: c.sticker_id, swapId: c.conflicting_swap_id })),
        });
      }
    }

    for (const item of items) {
      await client.query(
        `INSERT INTO swap_items (swap_id, sticker_id, from_user_id, to_user_id)
         VALUES ($1, $2, $3, $4)`,
        [swap.id, item.sticker_id, item.from_user_id, item.to_user_id]
      );
    }

    await client.query(
      `UPDATE matches SET status = 'proposed' WHERE id = $1`,
      [matchId]
    );

    await client.query('COMMIT');

    // Notify the other party that a swap has been proposed
    const { rows: proposerRows } = await pool.query('SELECT name FROM users WHERE id = $1', [userId]);
    const otherUserId = swap.user_a_id === userId ? swap.user_b_id : swap.user_a_id;
    await createNotification(pool, {
      userId: otherUserId,
      type: 'swap_proposed',
      title: `${proposerRows[0]?.name || 'Someone'} proposed a swap`,
      body: 'Check your matches to accept or decline.',
      swapId: swap.id,
    });

    res.status(201).json({ swap, items });
  } catch (err) {
    await client.query('ROLLBACK');
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

    const { rows: items } = await pool.query(
      `SELECT si.*, s.sticker_number, s.description, s.team_name
       FROM swap_items si
       JOIN stickers s ON s.id = si.sticker_id
       WHERE si.swap_id = $1`,
      [swapId]
    );

    const bothAccepted = swap.user_a_accepted && swap.user_b_accepted;
    let addresses = null;

    if (bothAccepted) {
      const otherUserId = swap.user_a_id === userId ? swap.user_b_id : swap.user_a_id;
      const { rows: addrRows } = await pool.query(
        `SELECT name, address_line1, address_line2, city, postcode, country
         FROM users WHERE id = $1`,
        [otherUserId]
      );
      addresses = addrRows[0];
    }

    res.json({ swap, items, otherUserAddress: addresses });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch swap' });
  }
});

// ----------------------------------------------------------------
// POST /api/swaps/:id/accept
// Mark this user's side as accepted. If both sides have now
// accepted, flip swap status to 'accepted' (unlocks addresses).
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

    // Before accepting, verify this user still actually has all the
    // stickers they're supposed to give. If any have already been
    // committed to another accepted swap (and therefore removed from
    // user_duplicates), block the acceptance with a clear message
    // rather than letting them over-promise.
    const { rows: itemsToGive } = await client.query(
      `SELECT si.sticker_id, s.sticker_number, s.description
       FROM swap_items si
       JOIN stickers s ON s.id = si.sticker_id
       WHERE si.swap_id = $1 AND si.from_user_id = $2`,
      [swapId, userId]
    );

    const missingStickers = [];
    for (const item of itemsToGive) {
      const { rows: dupeRows } = await client.query(
        `SELECT 1 FROM user_duplicates WHERE user_id = $1 AND sticker_id = $2`,
        [userId, item.sticker_id]
      );
      if (!dupeRows.length) {
        missingStickers.push(`${item.sticker_number} (${item.description})`);
      }
    }

    if (missingStickers.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: `You no longer have all the stickers needed for this swap. The following have already been committed to another accepted swap: ${missingStickers.join(', ')}. Please check your other active swaps.`,
        missingStickers,
      });
    }

    await client.query(
      `UPDATE swaps SET ${field} = TRUE, updated_at = NOW() WHERE id = $1`,
      [swapId]
    );

    const { rows: updatedRows } = await client.query(`SELECT * FROM swaps WHERE id = $1`, [swapId]);
    const updated = updatedRows[0];

    if (updated.user_a_accepted && updated.user_b_accepted && updated.status === 'proposed') {
      await client.query(
        `UPDATE swaps SET status = 'accepted', updated_at = NOW() WHERE id = $1`,
        [swapId]
      );

      // Once both sides have committed, pull the specific stickers in
      // this swap out of duplicates/needs so they stop being offered
      // to (or matched against) anyone else. We only remove what's
      // actually part of THIS swap, not a person's whole inventory —
      // someone may have other unrelated duplicates/needs for the
      // same sticker code from a different context, but practically
      // each sticker_id only ever has one duplicates/needs row per
      // user, so this is a precise, scoped cleanup either way.
      const { rows: items } = await client.query(
        `SELECT sticker_id, from_user_id, to_user_id FROM swap_items WHERE swap_id = $1`,
        [swapId]
      );

      for (const item of items) {
        // Decrement by 1, not delete entirely — user may have multiple copies.
        // Only remove the row if this was their last copy.
        await client.query(
          `UPDATE user_duplicates SET quantity = quantity - 1
           WHERE user_id = $1 AND sticker_id = $2`,
          [item.from_user_id, item.sticker_id]
        );
        await client.query(
          `DELETE FROM user_duplicates
           WHERE user_id = $1 AND sticker_id = $2 AND quantity <= 0`,
          [item.from_user_id, item.sticker_id]
        );
        await client.query(
          `DELETE FROM user_needs WHERE user_id = $1 AND sticker_id = $2`,
          [item.to_user_id, item.sticker_id]
        );
      }

      // Notify both parties that the swap is fully accepted
      const { rows: userRows } = await pool.query('SELECT name FROM users WHERE id = $1', [userId]);
      const otherUserId = updated.user_a_id === userId ? updated.user_b_id : updated.user_a_id;
      await createNotification(pool, {
        userId: otherUserId,
        type: 'swap_accepted',
        title: 'Swap accepted — time to post!',
        body: `${userRows[0]?.name || 'Your swap partner'} also accepted. Check the swap for their address.`,
        swapId,
      });
    }

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
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
// Withdraw from a swap that's still in 'proposed' state, but only
// if EXACTLY ONE side has accepted — i.e. you accepted but they
// haven't, or they accepted but you want to pull out before they do.
// Once both sides have accepted the swap is binding.
// ----------------------------------------------------------------
router.post('/:id/withdraw', async (req, res) => {
  const userId = req.user.id;
  const swapId = req.params.id;

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
      return res.status(400).json({ error: 'You can only withdraw before both sides have accepted' });
    }
    // Block if both have already accepted — swap is binding at that point
    if (swap.user_a_accepted && swap.user_b_accepted) {
      return res.status(400).json({ error: 'Both sides have already accepted — the swap is binding. Use the dispute process if there is a problem.' });
    }

    const withdrawerName = userId === swap.user_a_id ? swap.user_a_name : swap.user_b_name;
    const otherUserId = userId === swap.user_a_id ? swap.user_b_id : swap.user_a_id;

    // Mark as declined (reuse declined status — withdraw is a soft decline)
    await pool.query(
      `UPDATE swaps SET status = 'declined', updated_at = NOW(),
       declined_by_id = $1, decline_reason = 'Withdrawn by proposer'
       WHERE id = $2`,
      [userId, swapId]
    );

    // Notify the other party
    await pool.query(
      `INSERT INTO notifications (user_id, type, title, body)
       VALUES ($1, 'swap_declined', $2, $3)`,
      [
        otherUserId,
        'Swap withdrawn',
        `${withdrawerName} has withdrawn from your swap. Your stickers are available for new matches.`,
      ]
    ).catch(() => {});

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to withdraw from swap' });
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
    if (swap.status !== 'accepted') {
      return res.status(400).json({ error: 'Swap must be accepted before posting' });
    }

    const isUserA = swap.user_a_id === userId;
    const field = isUserA ? 'user_a_posted' : 'user_b_posted';
    const otherPostedField = isUserA ? 'user_b_posted' : 'user_a_posted';

    // Store photo on the swap and mark this user's side as posted
    if (photo) {
      await pool.query(
        `UPDATE swaps SET ${field} = TRUE, postage_photo = $1, updated_at = NOW() WHERE id = $2`,
        [photo, swapId]
      );
    } else {
      await pool.query(
        `UPDATE swaps SET ${field} = TRUE, updated_at = NOW() WHERE id = $1`,
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

    if (updated.user_a_received && updated.user_b_received) {
      await client.query(
        `UPDATE swaps SET status = 'completed', updated_at = NOW() WHERE id = $1`,
        [swapId]
      );

      // Adjust inventories: decrement duplicates sent, remove needs fulfilled
      const { rows: items } = await client.query(
        `SELECT * FROM swap_items WHERE swap_id = $1`,
        [swapId]
      );

      for (const item of items) {
        await client.query(
          `UPDATE user_duplicates SET quantity = quantity - 1
           WHERE user_id = $1 AND sticker_id = $2`,
          [item.from_user_id, item.sticker_id]
        );
        await client.query(
          `DELETE FROM user_duplicates WHERE user_id = $1 AND sticker_id = $2 AND quantity <= 0`,
          [item.from_user_id, item.sticker_id]
        );
        await client.query(
          `DELETE FROM user_needs WHERE user_id = $1 AND sticker_id = $2`,
          [item.to_user_id, item.sticker_id]
        );
      }
    }

    await client.query('COMMIT');
    res.json({ success: true, completed: updated.user_a_received && updated.user_b_received });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed to update received status' });
  } finally {
    client.release();
  }
});

module.exports = router;
