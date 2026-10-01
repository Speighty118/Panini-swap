const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { Pool } = require('pg');
const apply = require('../api/revenuecat_ledger');
// Explicit disposable socket only. No DATABASE_URL or inherited PG credentials.
const socket = process.env.GOS_LEDGER_TEST_SOCKET;
if (!socket || !socket.startsWith('/tmp/gos-ledger-')) throw Error('Disposable test socket required');
const pool = new Pool({host:socket,port:55439,user:'gos_test',database:'postgres',password:'unused',ssl:false});
const purchase = (id=1,time=100,extra={}) => ({id:`purchase-${id}-${time}`,event_timestamp_ms:time,environment:'PRODUCTION',type:'NON_RENEWING_PURCHASE',product_id:'com.gotonespare.app.founder.v2',transaction_id:`tx-${id}`,app_user_id:String(id),currency:'GBP',price_in_purchased_currency:14.99,...extra});
const transfer = (from,to,time=200) => ({id:`transfer-${from}-${to}-${time}`,event_timestamp_ms:time,environment:'PRODUCTION',type:'TRANSFER',transferred_from:[String(from)],transferred_to:[String(to)]});
const refund = (id=1,time=300) => purchase(id,time,{id:`refund-${id}-${time}`,type:'CANCELLATION',cancel_reason:'CUSTOMER_SUPPORT'});
async function reset(){await pool.query(`TRUNCATE founder_native_events,founder_native_purchases,founder_native_accounts,users CASCADE;
 INSERT INTO users(id,name,email) SELECT n,'Synthetic','test@example.invalid' FROM generate_series(1,5) n`);}
async function members(){return (await pool.query('SELECT id FROM users WHERE founder_member ORDER BY id')).rows.map(r=>r.id);}
test.before(async()=>{
 await pool.query(`CREATE TABLE users(id INTEGER PRIMARY KEY,name TEXT,email TEXT,founder_member BOOLEAN DEFAULT FALSE,founder_since TIMESTAMPTZ,membership_tier TEXT DEFAULT 'free',founder_payment_id TEXT,founder_amount INTEGER)`);
 await pool.query(fs.readFileSync(require('node:path').join(__dirname,'../db/migrations/20260929_founder_purchase_ledger.sql'),'utf8'));
});
test.after(()=>pool.end());
test('purchase grants once, GBP amount stored, repeated deliveries are idempotent',async()=>{await reset();assert.equal((await apply(pool,purchase())).length,1);assert.equal((await apply(pool,purchase())).length,0);assert.deepEqual(await members(),[1]);assert.equal((await pool.query('SELECT founder_amount FROM users WHERE id=1')).rows[0].founder_amount,1499);});
test('refund before purchase delivery cannot reactivate membership',async()=>{await reset();await apply(pool,refund());await apply(pool,purchase());assert.deepEqual(await members(),[]);});
test('transfer arriving first is reconciled when the original purchase arrives',async()=>{await reset();await apply(pool,transfer(1,2));await apply(pool,purchase());assert.deepEqual(await members(),[2]);});
test('transfer removes source access; refund follows transaction to current owner',async()=>{await reset();await apply(pool,purchase());await apply(pool,transfer(1,2));assert.deepEqual(await members(),[2]);await apply(pool,refund());assert.deepEqual(await members(),[]);await apply(pool,purchase(1,400,{id:'reversed',type:'REFUND_REVERSED'}));assert.deepEqual(await members(),[2]);});
test('reversed transfer delivery order resolves chains correctly',async()=>{await reset();await apply(pool,transfer(2,3,300));await apply(pool,purchase());await apply(pool,transfer(1,2,200));assert.deepEqual(await members(),[3]);});
test('pre-existing Founder and later Stripe purchase are preserved',async()=>{await reset();await pool.query("UPDATE users SET founder_member=TRUE,founder_payment_id='stripe-original' WHERE id=1");await apply(pool,purchase());await apply(pool,refund());assert.deepEqual(await members(),[1]);await reset();await apply(pool,purchase());await pool.query("UPDATE users SET founder_payment_id='stripe-later' WHERE id=1");await apply(pool,refund());assert.deepEqual(await members(),[1]);});
test('another active purchase keeps access after one refund',async()=>{await reset();await apply(pool,purchase());await apply(pool,purchase(1,150,{transaction_id:'another'}));await apply(pool,refund());assert.deepEqual(await members(),[1]);});
test('sandbox and tips never grant; unknown account rolls back for retry',async()=>{await reset();await apply(pool,purchase(1,100,{environment:'SANDBOX'}));await apply(pool,purchase(1,100,{product_id:'com.gotonespare.app.support.small'}));assert.deepEqual(await members(),[]);await assert.rejects(apply(pool,purchase(99)),/account missing/);assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM founder_native_events')).rows[0].n,0);});
test('unverifiable transfers fail for reconciliation rather than acknowledging a lost update',async()=>{await reset();await assert.rejects(apply(pool,{...transfer(1,2),environment:undefined}),/environment/);await assert.rejects(apply(pool,{...transfer(1,2),transferred_to:['2','3']}),/unambiguous/);assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM founder_native_events')).rows[0].n,0);});
test('authenticated handler commits once and rejects unauthorized events before database work',async()=>{
 await reset();let notifications=0;
 const handler=require('../api/revenuecat_handler')({pool,secret:'local-test-secret',ledger:apply,notify:async()=>notifications++,welcome:async()=>{}});
 async function call(event,authorization='Bearer local-test-secret'){let status=200;const res={status(n){status=n;return this},json(){return this}};await handler({headers:{authorization},body:{event}},res);return status;}
 assert.equal(await call(purchase(),'wrong'),401);assert.deepEqual(await members(),[]);
 assert.equal(await call(purchase()),200);assert.equal(await call(purchase()),200);assert.equal(notifications,1);
 assert.equal(await call(purchase(99)),500);assert.deepEqual(await members(),[1]);
});
test('authoritative reconciliation handles restore, transfer, refund and repeat calls',async()=>{
 await reset();const {createSync}=require('../api/revenuecat_sync');let owner=1,active=true;
 const sync=createSync({pool,apiKey:'test-public',fetchImpl:async url=>{const id=Number(url.split('/').pop());return {ok:true,json:async()=>({subscriber:{entitlements:active&&id===owner?{founder:{expires_date:null,product_identifier:'com.gotonespare.app.founder.v2',purchase_date:'2026-09-29'}}:{},non_subscriptions:{'com.gotonespare.app.founder.v2':[{id:'verified',is_sandbox:false,store:'app_store',purchase_date:'2026-09-29'}]}}})};}});
 assert.equal((await sync([1])).length,1);assert.equal((await sync([1])).length,0);
 owner=2;await sync([1,2]);assert.deepEqual(await members(),[2]);active=false;await sync([2]);assert.deepEqual(await members(),[]);
});
test('sandbox access is confined to the server-configured review account',async()=>{
 await reset();await pool.query("UPDATE users SET email='review@example.invalid' WHERE id=1");
 const {createSync}=require('../api/revenuecat_sync');
 const fetchImpl=async()=>({ok:true,json:async()=>({subscriber:{entitlements:{founder:{expires_date:null,product_identifier:'com.gotonespare.app.founder.v2',purchase_date:'2026-10-01'}},non_subscriptions:{'com.gotonespare.app.founder.v2':[{id:'sandbox-test',is_sandbox:true,store:'app_store',purchase_date:'2026-10-01'}]}}})});
 await createSync({pool,apiKey:'test',fetchImpl})([1,2]);assert.deepEqual(await members(),[]);
 await createSync({pool,apiKey:'test',fetchImpl,sandboxReviewEmail:'review@example.invalid'})([1,2]);assert.deepEqual(await members(),[1]);
});
