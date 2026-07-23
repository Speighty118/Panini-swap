/**
 * Shared "send to every active user" logic, used by both the instant
 * admin broadcast and the scheduled-announcement cron job — kept in one
 * place so the two paths can't quietly drift apart.
 */

async function sendBroadcastToAllUsers(pool, { title, body, type = 'announcement' }) {
  const { rows: users } = await pool.query(
    `SELECT id FROM users WHERE is_suspended = FALSE AND is_active = TRUE`
  );
  for (const user of users) {
    await pool.query(
      `INSERT INTO notifications (user_id, type, title, body)
       VALUES ($1, $2, $3, $4)`,
      [user.id, type, title.trim(), body?.trim() || null]
    );
  }

  // Push to all subscribed users — fire and forget
  const { sendPushNotification } = require('./push');
  const { rows: pushUsers } = await pool.query(
    `SELECT id FROM users WHERE push_subscription IS NOT NULL`
  );
  pushUsers.forEach(u => {
    sendPushNotification(u.id, {
      title: `📢 ${title.trim()}`,
      body: body?.trim()?.slice(0, 100) || '',
    }).catch(() => {});
  });

  return { sentCount: users.length, pushCount: pushUsers.length };
}

module.exports = { sendBroadcastToAllUsers };
