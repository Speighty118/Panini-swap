/**
 * XP / level system.
 *
 * Award points for real, verified actions only — never for actions a
 * user can spam on their own (like adding stickers), so XP stays a
 * trustworthy signal rather than something to be gamed.
 *
 * Every award goes through awardXp(), which logs to xp_events and
 * bumps users.xp in the same call. The (user_id, event_type,
 * related_id) unique constraint on xp_events makes every award
 * idempotent — call it as many times as you like for the same real
 * event (e.g. a swap completing) and it only ever counts once.
 * related_id defaults to 0 for events that aren't tied to a specific
 * row (e.g. the one-time first-swap or ambassador bonus) — 0 rather
 * than NULL so the unique constraint actually applies (Postgres
 * treats NULL <> NULL, which would let duplicates through).
 */

const XP_VALUES = {
  completed_swap: 50,
  first_swap_bonus: 50,
  verified_postage: 10,
  rating_given: 10,
  ambassador_bonus: 30,
};

// Cumulative XP required to reach each level. Index 0 = level 1.
// A gentle early curve, widening later — tune freely, level is
// always computed from this list rather than stored separately.
const LEVEL_THRESHOLDS = [0, 100, 250, 450, 700, 1000, 1400, 1900, 2500, 3200, 4000, 5000, 6200, 7600, 9200];

function levelForXp(xp) {
  let level = 1;
  for (let i = 0; i < LEVEL_THRESHOLDS.length; i++) {
    if (xp >= LEVEL_THRESHOLDS[i]) level = i + 1;
    else break;
  }
  return level;
}

function xpForNextLevel(xp) {
  const next = LEVEL_THRESHOLDS.find((t) => t > xp);
  return next === undefined ? null : next; // null once past the top defined level
}

// Threshold the current level started at — lets the frontend show
// progress within the current level band, not just overall XP.
function xpForCurrentLevel(xp) {
  let start = 0;
  for (const t of LEVEL_THRESHOLDS) {
    if (xp >= t) start = t;
    else break;
  }
  return start;
}

async function awardXp(pool, { userId, eventType, relatedId = 0 }) {
  const amount = XP_VALUES[eventType];
  if (!amount) {
    console.error(`XP award error: unknown event type "${eventType}"`);
    return;
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO xp_events (user_id, event_type, amount, related_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, event_type, related_id) DO NOTHING
       RETURNING id`,
      [userId, eventType, amount, relatedId]
    );
    if (rows.length > 0) {
      await pool.query(`UPDATE users SET xp = xp + $1 WHERE id = $2`, [amount, userId]);
    }
  } catch (err) {
    console.error('XP award error:', err.message);
  }
}

module.exports = { XP_VALUES, LEVEL_THRESHOLDS, levelForXp, xpForNextLevel, xpForCurrentLevel, awardXp };
