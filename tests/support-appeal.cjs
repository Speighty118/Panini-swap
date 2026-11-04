const test=require('node:test');const assert=require('node:assert/strict');
const {encode,decode,sendBatch}=require('../api/support_appeal');
const secret='synthetic-secret';
test('preview rejects tampering, expiry and a different secret',()=>{
 const now=Date.parse('2026-11-04T12:00:00Z');const token=encode([1,2],secret,now);
 assert.deepEqual(decode(token,secret,now).ids,[1,2]);
 assert.throws(()=>decode(token+'x',secret,now));assert.throws(()=>decode(token,'other',now));assert.throws(()=>decode(token,secret,now+86400001));
});
test('retry skips committed messages and does not repeat push',async()=>{
 let sent=false,pushes=0,locked=false;const queries=[];
 const client={release(){},async query(sql){queries.push(sql);if(sql.includes('advisory'))locked=true;
 if(sql.includes('SELECT u.id')){assert.ok(locked);return {rows:sent?[]:[{id:3}]};}
 if(sql.includes('SELECT c.id'))return {rows:[{id:8}]};
 if(sql.startsWith('INSERT INTO direct_messages'))sent=true;
 return {rows:[]};}};
 const pool={connect:async()=>client};const token=encode([3],secret);
 assert.equal((await sendBatch(pool,secret,token,async()=>{pushes++;throw Error('push unavailable')})).sent,1);
 assert.equal((await sendBatch(pool,secret,token,async()=>pushes++)).sent,0);assert.equal(pushes,1);
 assert.ok(queries.includes('COMMIT'));
});
test('database failure rolls back and never sends push',async()=>{
 let rollback=false,pushes=0;const client={release(){},async query(sql){if(sql.includes('SELECT u.id'))return {rows:[{id:3}]};if(sql.includes('SELECT c.id'))return {rows:[{id:8}]};if(sql.startsWith('INSERT INTO notifications'))throw Error('failure');if(sql==='ROLLBACK')rollback=true;return {rows:[]};}};
 await assert.rejects(sendBatch({connect:async()=>client},secret,encode([3],secret),async()=>pushes++));assert.equal(rollback,true);assert.equal(pushes,0);
});
