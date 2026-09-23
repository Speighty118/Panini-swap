// Explicit release command; never loads a local .env or starts background jobs.
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { Client } = require('pg');

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const client = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10000 });
  await client.connect();
  try {
    await client.query("SET lock_timeout = '10s'");
    await client.query("SET statement_timeout = '60s'");
    await client.query(readFileSync(join(__dirname, '../db/migrations/20260921_collection_invitations.sql'), 'utf8'));
    console.log('Collection invitation migration complete.');
  } finally { await client.end(); }
}
main().catch(error => { console.error('Collection invitation migration failed:', error.code || error.name); process.exitCode = 1; });
