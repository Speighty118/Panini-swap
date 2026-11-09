const crypto = require('node:crypto');
const SENDER = 121;
const KEY = 'winter-update-2026-11-09';
const DEADLINE = Date.parse('2026-11-12T00:00:00Z');
const BODY = `Hi everyone, it’s Tom from Got One Spare? 👋

More than 500 of you have joined Got One Spare? Together you’ve started over 5,400 swaps, and 768 are marked as completed. If you’ve ever opened an envelope and found the sticker you needed for that stubborn gap in your album, that’s exactly why I built this. Thank you for being part of it.

I said I’d let you know how the appeal was going. So far, we’ve raised £10 towards our £150 goal. A heartfelt thank you to the collectors who chipped in. We have until the end of Wednesday 11 November, UK time. If we reach £150 by then, swapping will stay open. If we fall short, I’ll need to pause Got One Spare? between collections.

If we do pause, we’ll close new swap proposals first. If you’ve already agreed a swap or put stickers in the post, you’ll still be able to message your partner, mark stickers as posted or received, and report a problem. I’ll send the exact dates and give everyone at least two weeks from that notice to finish up.

We plan to be back for the men’s Euros in 2028. We’ll keep your account and your collection lists so you can sign back in with the same details when we reopen. During the break, you’ll be able to check gotonespare.com for news.

If you’d like to help, you can make a one-off contribution of £3, £5 or £10. Donations received by the deadline count towards keeping swapping open. If we do pause, you’ll still be able to donate towards developing Got One Spare? for future collections.

On iPhone, open More → Support Got One Spare?
On the website, tap https://www.gotonespare.com/?support=1

Please only give if it’s comfortable for you. Whether you donated, helped someone finish a page, or trusted a stranger enough to put an envelope in the post, thank you.

Tom 💛`;
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
   await client.query(`INSERT INTO notifications (user_id,type,title,body) VALUES ($1,'direct_message','An update from Tom about winter swapping 💛',$2)`,[user.id,'We’ve raised £10 towards our £150 goal. Please open your inbox for what happens after 11 November and how to finish any swaps already under way.']);
   delivered.push(user.id);
  }
  await client.query('COMMIT');
 } catch(error) {await client.query('ROLLBACK');throw error;} finally {client.release();}
 // Inbox delivery is the durable record. Push is best effort and never retried on resume.
 await Promise.allSettled(delivered.map(id=>Promise.resolve().then(()=>push(id,{title:'💬 An update from Tom about winter swapping 💛',body:'We’ve raised £10 towards our £150 goal. Please open your inbox for what happens after 11 November and how to finish any swaps already under way.'}))));
 return {sent:delivered.length,done:delivered.length===0};
}
module.exports={BODY,KEY,encode,decode,preview,sendBatch};
