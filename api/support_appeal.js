const crypto = require('node:crypto');
const SENDER = 121;
const KEY = 'support-2026-11-11';
const DEADLINE = Date.parse('2026-11-12T00:00:00Z');
const BODY = `Hi, it’s Tom, the person behind Got One Spare? 👋

I’m reaching out to our members because I need your help keeping the app and website running.

We’ve grown to over 500 members, with 5,400 swaps started through Got One Spare? It means a lot to see something I’ve built helping collectors find each other and fill those gaps in their albums.

But keeping it running costs money, and I’m struggling to keep covering those costs myself.

Our goal is to raise £150 by 11 November. That’s 50 members giving £3. Without enough ongoing support, I’ll have to close the app and website—and I’d really love to keep this community going.

Even if you’ve finished your collection or aren’t using Got One Spare? right now, I hope you’ll think of us for the next one. I want to keep adding support for future sticker and card collections, so we’re here whenever you’re ready to swap again.

If you can comfortably spare £3, £5 or £10, a one-off contribution would help.

📱 Using the iPhone app? Update to the latest version, then open More → Support Got One Spare? to contribute directly through the app.

🌐 Prefer the website? You can contribute here:
https://www.gotonespare.com/?support=1

Please don’t stretch yourself if money is tight—you’re still very welcome here. And if you’ve already contributed, thank you. I really appreciate it.

Thanks for being part of Got One Spare? 💛
Tom`;
const ELIGIBLE = `u.id <> ${SENDER} AND COALESCE(u.is_suspended,FALSE) = FALSE
 AND u.email IS NOT NULL AND u.email !~* '^gotonespare@'
 AND COALESCE(u.name,'') !~* '(appletest|testaccount|testpartner|^test\\y)'
 AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE
 (b.blocker_id=u.id AND b.blocked_id=${SENDER}) OR (b.blocker_id=${SENDER} AND b.blocked_id=u.id))`;
const signature = (value,secret) => crypto.createHmac('sha256',secret).update(value).digest('hex');
function encode(ids,secret,now=Date.now()) {
 const data=Buffer.from(JSON.stringify({key:KEY,ids,expires:Math.min(now+86400000,DEADLINE),bodyHash:signature(BODY,secret)})).toString('base64url');
 return data+'.'+signature(data,secret);
}
function decode(token,secret,now=Date.now()) {
 const [data,sig]=String(token||'').split('.'); const expected=signature(data||'',secret);
 if(!sig || sig.length!==expected.length || !crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(expected))) throw new Error('Invalid preview. Preview the campaign again.');
 const p=JSON.parse(Buffer.from(data,'base64url').toString());
 if(p.key!==KEY || p.expires<=now || now>=DEADLINE || p.bodyHash!==signature(BODY,secret) || !Array.isArray(p.ids) || p.ids.length>10000 || !p.ids.every(Number.isSafeInteger)) throw new Error('Preview expired. Preview the campaign again.');
 return p;
}
async function preview(pool,secret) {
 if(Date.now()>=DEADLINE) throw new Error('This appeal has ended.');
 const sender=await pool.query('SELECT name FROM users WHERE id=$1',[SENDER]);
 if(!/support/i.test(sender.rows[0]?.name||'')) throw new Error('Support sender account needs verification.');
 const {rows}=await pool.query(`SELECT u.id,u.name, EXISTS (SELECT 1 FROM direct_messages d JOIN conversation_participants cp ON cp.conversation_id=d.conversation_id WHERE cp.user_id=u.id AND d.sender_id=$1 AND d.body=$2) AS sent FROM users u WHERE ${ELIGIBLE} ORDER BY u.id`,[SENDER,BODY]);
 return {key:KEY,body:BODY,sender:sender.rows[0].name,total:rows.length,sent:rows.filter(r=>r.sent).length,recipients:rows.map(r=>({id:r.id,name:r.name,sent:r.sent})),token:encode(rows.map(r=>Number(r.id)),secret)};
}
async function sendBatch(pool,secret,token,push) {
 const {ids}=decode(token,secret); const client=await pool.connect(); const delivered=[];
 try {
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[KEY]);
  const {rows}=await client.query(`SELECT u.id FROM users u WHERE u.id=ANY($3::int[]) AND ${ELIGIBLE}
   AND NOT EXISTS (SELECT 1 FROM direct_messages d JOIN conversation_participants cp ON cp.conversation_id=d.conversation_id WHERE cp.user_id=u.id AND d.sender_id=$1 AND d.body=$2) ORDER BY u.id LIMIT 25`,[SENDER,BODY,ids]);
  for(const user of rows) {
   const existing=await client.query(`SELECT c.id FROM conversations c JOIN conversation_participants a ON a.conversation_id=c.id AND a.user_id=$1 JOIN conversation_participants b ON b.conversation_id=c.id AND b.user_id=$2 ORDER BY c.id LIMIT 1`,[SENDER,user.id]);
   let conversation=existing.rows[0]?.id;
   if(!conversation) {
    conversation=(await client.query('INSERT INTO conversations DEFAULT VALUES RETURNING id')).rows[0].id;
    await client.query('INSERT INTO conversation_participants (conversation_id,user_id) VALUES ($1,$2),($1,$3)',[conversation,SENDER,user.id]);
   }
   await client.query('INSERT INTO direct_messages (conversation_id,sender_id,body) VALUES ($1,$2,$3)',[conversation,SENDER,BODY]);
   await client.query(`INSERT INTO notifications (user_id,type,title,body) VALUES ($1,'direct_message','A message from Tom at Got One Spare?',$2)`,[user.id,'Help keep Got One Spare? running. Please read the message in your inbox.']);
   delivered.push(user.id);
  }
  await client.query('COMMIT');
 } catch(error) {await client.query('ROLLBACK');throw error;} finally {client.release();}
 // Inbox delivery is the durable record. Push is best effort and never retried on resume.
 await Promise.allSettled(delivered.map(id=>Promise.resolve().then(()=>push(id,{title:'💬 A message from Tom at Got One Spare?',body:'Help keep Got One Spare? running. Please read the message in your inbox.'}))));
 return {sent:delivered.length,done:delivered.length===0};
}
module.exports={BODY,KEY,encode,decode,preview,sendBatch};
