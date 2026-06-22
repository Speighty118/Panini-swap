/**
 * Fix the v_possible_gives view which Railway's Data tab corrupted
 * by adding LIMIT 100 to the view definition.
 * 
 * Run with: node scripts/fix_view.js
 * Requires DATABASE_URL in environment.
 */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  console.log('Dropping and recreating v_possible_gives view...');

  await pool.query(`DROP VIEW IF EXISTS v_possible_gives`);
  console.log('✓ Dropped old view');

  await pool.query(`
    CREATE VIEW v_possible_gives AS
    SELECT
        d.user_id   AS giver_id,
        n.user_id   AS receiver_id,
        d.sticker_id
    FROM user_duplicates d
    JOIN user_needs n ON n.sticker_id = d.sticker_id
    WHERE d.user_id <> n.user_id
    AND NOT EXISTS (
        SELECT 1
        FROM swap_items si
        JOIN swaps sw ON sw.id = si.swap_id
        WHERE si.sticker_id = d.sticker_id
        AND si.from_user_id = d.user_id
        AND sw.status IN ('proposed', 'accepted')
    )
  `);
  console.log('✓ Created new view (no LIMIT)');

  // Verify
  const { rows } = await pool.query(`SELECT pg_get_viewdef('v_possible_gives', true) AS def`);
  const def = rows[0].def;
  console.log('\nView definition:');
  console.log(def);

  if (def.includes('LIMIT')) {
    console.error('\n❌ LIMIT still present — something is wrong');
  } else {
    console.log('\n✅ No LIMIT — view is clean!');
  }

  // Check Simon's count
  const { rows: simonRows } = await pool.query(`
    SELECT COUNT(*) FROM v_possible_gives 
    WHERE giver_id = (SELECT id FROM users WHERE email = 'si_noakes@yahoo.co.uk')
  `);
  console.log(`\nSimon's potential gives: ${simonRows[0].count}`);

  await pool.end();
}

run().catch(err => {
  console.error('Failed:', err);
  process.exit(1);
});
