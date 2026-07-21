/**
 * TEMPORARY one-off script — backfills postcode_latitude/postcode_longitude
 * for existing users who already have a postcode but no coordinates yet
 * (anyone who saved their profile before the "distance on matches" feature
 * existed). New/updated profiles geocode automatically from now on via
 * PUT /api/auth/me — this just catches everyone already in the database.
 *
 * Uses postcodes.io's free bulk lookup endpoint, 100 postcodes per batch.
 * Safe to re-run — only ever touches users missing coordinates.
 *
 * Run: node geocode_backfill.js
 * Requires DATABASE_URL in the environment (or a .env file in this folder).
 */

require('dotenv').config();
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Add it to a .env file in backend/ or export it in your shell before running this script.');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const BATCH_SIZE = 100;

async function run() {
  const { rows: users } = await pool.query(
    `SELECT id, postcode FROM users
     WHERE postcode IS NOT NULL
       AND (postcode_latitude IS NULL OR postcode_longitude IS NULL)`
  );

  console.log(`Found ${users.length} user(s) needing a postcode lookup.`);
  if (users.length === 0) {
    await pool.end();
    return;
  }

  let geocoded = 0;
  let failed = 0;

  for (let i = 0; i < users.length; i += BATCH_SIZE) {
    const batch = users.slice(i, i + BATCH_SIZE);
    console.log(`Looking up batch ${Math.floor(i / BATCH_SIZE) + 1} (${batch.length} postcodes)...`);

    const res = await fetch('https://api.postcodes.io/postcodes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ postcodes: batch.map((u) => u.postcode) }),
    });
    const data = await res.json();

    if (!data.result) {
      console.error('Unexpected response from postcodes.io:', JSON.stringify(data).slice(0, 300));
      failed += batch.length;
      continue;
    }

    for (const entry of data.result) {
      const user = batch.find((u) => u.postcode === entry.query);
      if (!user) continue;

      if (entry.result) {
        await pool.query(
          `UPDATE users SET postcode_latitude = $1, postcode_longitude = $2 WHERE id = $3`,
          [entry.result.latitude, entry.result.longitude, user.id]
        );
        geocoded++;
      } else {
        console.log(`  No match for postcode "${user.postcode}" (user #${user.id})`);
        failed++;
      }
    }
  }

  console.log(`Done — geocoded ${geocoded}, failed/unmatched ${failed}.`);
  await pool.end();
}

run().catch((err) => {
  console.error('Backfill failed:', err.message);
  process.exit(1);
});
