// Deployment migration only; never loads local credentials or runs jobs.
const {Pool}=require('pg');const fs=require('node:fs');const path=require('node:path');
const pool=new Pool({connectionString:process.env.DATABASE_URL});
(async()=>{const db=await pool.connect();try{await db.query('BEGIN');await db.query('SELECT pg_advisory_xact_lock(73190422)');await db.query(fs.readFileSync(path.join(__dirname,'../db/migrations/20261104_apple_donations.sql'),'utf8'));await db.query('COMMIT');console.log('Apple support reporting schema ready.');}catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();await pool.end();}})().catch(()=>{console.error('Apple support migration failed; startup stopped.');process.exitCode=1;});
