// Release-only opt-in. No dotenv loading and no application jobs.
if (process.env.FOUNDER_LEDGER_ENABLED === 'true') {
 const {Pool}=require('pg');const fs=require('fs');const path=require('path');
 const pool=new Pool({connectionString:process.env.DATABASE_URL});
 (async()=>{const db=await pool.connect();try{await db.query('BEGIN');await db.query('SELECT pg_advisory_xact_lock(73190421)');await db.query(fs.readFileSync(path.join(__dirname,'../db/migrations/20260929_founder_purchase_ledger.sql'),'utf8'));await db.query('COMMIT');console.log('Support membership schema ready.');}catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();await pool.end();}})().catch(()=>{console.error('Support membership migration failed; startup stopped.');process.exitCode=1;});
}
