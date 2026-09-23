const express = require('express');
const crypto = require('crypto');
const { Pool } = require('pg');
const { requireAuth } = require('./middleware/auth');
const router = express.Router();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const normalise = code => String(code || '').trim().toUpperCase();
const valid = code => /^[A-F0-9]{12}$/.test(code);
const wrap = fn => async (req, res) => { try { await fn(req, res); } catch (err) { console.error('Collection invitation:', err.message); res.status(500).json({ error: 'Unable to load collection invitation. Please try again.' }); } };
async function invitation(db, code) {
 if (!valid(code)) return null;
 const {rows} = await db.query(`SELECT i.*, split_part(trim(u.name),' ',1) AS first_name FROM collection_invitations i JOIN users u ON u.id=i.owner_id WHERE i.code=$1 AND i.active AND NOT COALESCE(u.is_suspended,false) AND NOT COALESCE(u.matching_paused,false)`, [code]);
 return rows[0];
}
async function blocked(db, a, b) {
 const {rows} = await db.query('SELECT 1 FROM user_blocks WHERE (blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1)', [a,b]);
 return !!rows.length;
}
// Called only by server-side signup. An existing user cannot mark themselves a new signup.
async function recordSignup(userId, code) {
 const i = await invitation(pool, normalise(code));
 if (!i || i.owner_id === userId) return;
 await pool.query(`INSERT INTO collection_invitation_visitors(user_id,invitation_id,new_signup) VALUES($1,$2,true) ON CONFLICT(user_id) DO NOTHING`,[userId,i.id]);
}
// Idempotent qualification on saved inventory, scoped to the invited album.
// Verification is required so an unverified account cannot mint a badge.
async function qualify(db, ownerId) {
 await db.query(`UPDATE collection_invitation_visitors v SET qualified_at=now()
 FROM collection_invitations i, users u
 WHERE v.invitation_id=i.id AND i.owner_id=$1 AND i.active AND v.new_signup
 AND v.qualified_at IS NULL AND u.id=v.user_id AND u.email_verified AND NOT COALESCE(u.is_suspended,false)
 AND EXISTS(SELECT 1 FROM user_duplicates d JOIN stickers s ON s.id=d.sticker_id WHERE d.user_id=v.user_id AND d.quantity>0 AND s.album_id=i.album_id)
 AND EXISTS(SELECT 1 FROM user_needs n JOIN stickers s ON s.id=n.sticker_id WHERE n.user_id=v.user_id AND s.album_id=i.album_id)
 AND NOT EXISTS(SELECT 1 FROM user_blocks b WHERE (b.blocker_id=v.user_id AND b.blocked_id=i.owner_id) OR (b.blocker_id=i.owner_id AND b.blocked_id=v.user_id))`,[ownerId]);
 const award = await db.query(`INSERT INTO user_badges(user_id,badge_type)
 SELECT $1,'community_builder' WHERE EXISTS(SELECT 1 FROM collection_invitation_visitors v JOIN collection_invitations i ON i.id=v.invitation_id WHERE i.owner_id=$1 AND v.qualified_at IS NOT NULL)
 ON CONFLICT DO NOTHING RETURNING user_id`,[ownerId]);
 if(award.rows.length) await db.query(`INSERT INTO notifications(user_id,type,title,body) VALUES($1,'achievement','Community Builder unlocked','A collector joined through your collection invitation, verified their account and added spares and missing items. Thank you for helping the community grow.')`,[ownerId]);
}
router.get('/public/:code', wrap(async(req,res)=>{
 const i=await invitation(pool,normalise(req.params.code));
 if(!i) return res.status(404).json({error:'This invitation is unavailable or has been disabled.'});
 const {rows:counts}=await pool.query(`SELECT (SELECT count(*)::int FROM user_duplicates d JOIN stickers s ON s.id=d.sticker_id WHERE d.user_id=$1 AND d.quantity>0 AND s.album_id=$2) AS spares,(SELECT count(*)::int FROM user_needs n JOIN stickers s ON s.id=n.sticker_id WHERE n.user_id=$1 AND s.album_id=$2) AS needs`,[i.owner_id,i.album_id]);
 // Fixed server-side sample; no search/pagination endpoint that could reconstruct the full list.
 const {rows:samples}=await pool.query(`SELECT s.sticker_number,s.description,s.team_name FROM user_duplicates d JOIN stickers s ON s.id=d.sticker_id WHERE d.user_id=$1 AND d.quantity>0 AND s.album_id=$2 ORDER BY s.id LIMIT 3`,[i.owner_id,i.album_id]);
 res.set('Cache-Control','no-store').json({code:i.code,album_id:i.album_id,name:i.first_name,...counts[0],samples});
}));
router.use(requireAuth);
router.use(async (req,res,next) => {
 try {
  const {rows}=await pool.query('SELECT id,email_verified,matching_paused,is_suspended FROM users WHERE id=$1',[req.user.id]);
  if(!rows[0] || rows[0].is_suspended) return res.status(403).json({error:'This account cannot use collection invitations.'});
  req.collector=rows[0]; next();
 } catch(err) { next(err); }
});
router.get('/mine',wrap(async(req,res)=>{
 const albumId=Number(req.query.albumId);
 if(!Number.isSafeInteger(albumId)||albumId<1) return res.status(400).json({error:'Choose an album.'});
 const db=await pool.connect();
 try {
  await db.query('BEGIN'); await qualify(db,req.user.id);
  const {rows}=await db.query('SELECT code FROM collection_invitations WHERE owner_id=$1 AND album_id=$2 AND active',[req.user.id,albumId]);
  const {rows:counts}=await db.query(`SELECT count(*)::int AS qualified FROM collection_invitation_visitors v JOIN collection_invitations i ON i.id=v.invitation_id WHERE i.owner_id=$1 AND v.qualified_at IS NOT NULL`,[req.user.id]);
  await db.query('COMMIT'); res.json({code:rows[0]?.code||null,qualified:counts[0].qualified});
 } catch(err) {await db.query('ROLLBACK');throw err;} finally {db.release();}
}));
router.post('/',wrap(async(req,res)=>{
 if(!req.collector.email_verified || req.collector.matching_paused) return res.status(403).json({error:'Verify your email and resume matching before sharing your collection.'});
 const albumId=Number(req.body.albumId);
 if(!Number.isSafeInteger(albumId)||albumId<1) return res.status(400).json({error:'Choose an album.'});
 if(!(await pool.query('SELECT id FROM albums WHERE id=$1',[albumId])).rows.length) return res.status(404).json({error:'Album unavailable.'});
 await pool.query(`INSERT INTO collection_invitations(code,owner_id,album_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,[crypto.randomBytes(6).toString('hex').toUpperCase(),req.user.id,albumId]);
 const {rows}=await pool.query('SELECT code FROM collection_invitations WHERE owner_id=$1 AND album_id=$2 AND active',[req.user.id,albumId]);
 if(!rows[0]) return res.status(409).json({error:'Please try creating your invitation again.'});
 res.json(rows[0]);
}));
router.delete('/:code',wrap(async(req,res)=>{
 const {rows}=await pool.query('UPDATE collection_invitations SET active=false WHERE code=$1 AND owner_id=$2 RETURNING id',[normalise(req.params.code),req.user.id]);
 if(!rows.length) return res.status(404).json({error:'Invitation not found.'});
 res.json({disabled:true});
}));
router.get('/:code/comparison',wrap(async(req,res)=>{
 const i=await invitation(pool,normalise(req.params.code));
 if(!i || await blocked(pool,req.user.id,i.owner_id)) return res.status(404).json({error:'This invitation is unavailable.'});
 if(i.owner_id===req.user.id) return res.status(400).json({error:'This is your own collection invitation.'});
 if(req.collector.matching_paused) return res.status(403).json({error:'Resume matching to compare collections.'});
 // Only locate an existing match. Normal preview/proposal endpoints retain every swap rule.
 const {rows}=await pool.query(`SELECT id FROM matches WHERE album_id=$1 AND status='pending' AND ((user_a_id=$2 AND user_b_id=$3) OR (user_a_id=$3 AND user_b_id=$2)) ORDER BY computed_at DESC LIMIT 1`,[i.album_id,req.user.id,i.owner_id]);
 res.json({album_id:i.album_id,name:i.first_name,match_id:rows[0]?.id||null});
}));
module.exports=router;
module.exports.recordSignup=recordSignup;

