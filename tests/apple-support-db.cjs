const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {Pool}=require('pg');const {record,report}=require('../api/apple_support');
const host=process.env.GOS_LEDGER_TEST_SOCKET;
if(!host?.startsWith('/tmp/gos-ledger-'))throw Error('Disposable socket required');
const pool=new Pool({host,port:55439,user:'gos_test',database:'postgres',password:'unused',ssl:false});
test.after(()=>pool.end());
test('migration is repeatable; durable duplicates and refund ordering produce correct report',async()=>{
 await pool.query('CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,name TEXT,email TEXT)');
 const sql=fs.readFileSync('db/migrations/20261104_apple_donations.sql','utf8');await pool.query(sql);await pool.query(sql);
 const e={id:'purchase',transaction_id:'txn',type:'NON_RENEWING_PURCHASE',environment:'PRODUCTION',store:'APP_STORE',product_id:'com.gotonespare.app.support.medium',app_user_id:'123',event_timestamp_ms:1000,purchased_at_ms:1000,currency:'GBP',price_in_purchased_currency:5};
 await record(pool,{...e,id:'refund',type:'CANCELLATION',event_timestamp_ms:2000});await record(pool,e,'admin_recovery');await record(pool,e);
 const result=await report(pool,{from:new Date(0).toISOString(),to:new Date(4000).toISOString()});
 assert.equal(result.payments[0].source,'admin_recovery');assert.equal(result.grossPence,500);assert.equal(result.refundPence,500);assert.equal(result.paidCount,1);assert.ok(result.trackingSince);
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM apple_support_events')).rows[0].n,2);
 assert.equal((await report(pool,{from:new Date(5000).toISOString(),to:new Date(6000).toISOString()})).grossPence,0);
});
