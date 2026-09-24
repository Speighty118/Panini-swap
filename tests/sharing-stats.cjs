const assert=require('node:assert/strict');
const {Client}=require('pg');
const stats=require('../api/collection_sharing_stats');
(async()=>{
 const db=new Client({connectionString:'postgresql://gos_test@127.0.0.1:55437/gos_integration'});await db.connect();
 try {
  const data=await stats(db,{days:'all'});
  assert.ok(data.totals.signups>0);
  assert.equal(data.albums.reduce((n,a)=>n+a.signups,0),data.totals.signups);
  assert.equal(data.daily.reduce((n,a)=>n+a.signups,0),data.totals.signups);
  for(const a of data.albums){const single=await stats(db,{days:'all',albumId:String(a.id)});assert.equal(single.totals.signups,a.signups);assert.equal(single.albums.length,1);}
  await assert.rejects(()=>stats(db,{days:'garbage'}),{status:400});
  await assert.rejects(()=>stats(db,{albumId:'1 OR 1=1'}),{status:400});
  const empty=await stats(db,{days:'7',albumId:'999999'});assert.equal(empty.totals.signups,0);
  console.log('PASS: album isolation, aggregate and timeline reconciliation, empty state, invalid filters');
 }finally{await db.end();}
})().catch(e=>{console.error(e);process.exitCode=1});
