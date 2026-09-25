// Read-only, called only behind requireAdmin. No qualification side effects.
module.exports = async function referrals(db, { ownerId, days = '30', albumId = '', offset = '0' } = {}) {
  const id = value => /^[1-9]\d*$/.test(String(value)) && Number(value) <= 2147483647;
  if (!id(ownerId) || !['7','30','90','all'].includes(String(days)) || (albumId && !id(albumId)) || !/^\d+$/.test(String(offset)) || Number(offset) > 2147483647) {
    const error = new Error('Choose valid referral filters.'); error.status = 400; throw error;
  }
  const result = await db.query(`SELECT u.id,u.name,a.name AS collection,v.created_at,v.qualified_at
    FROM collection_invitation_visitors v
    JOIN collection_invitations i ON i.id=v.invitation_id
    JOIN users u ON u.id=v.user_id JOIN albums a ON a.id=i.album_id
    WHERE v.new_signup AND i.owner_id=$1
      AND ($2::int IS NULL OR v.created_at >= now()-make_interval(days=>$2))
      AND ($3::int IS NULL OR i.album_id=$3)
    ORDER BY v.created_at DESC,u.id LIMIT 51 OFFSET $4`,
    [Number(ownerId),days === 'all' ? null : Number(days),albumId ? Number(albumId) : null,Number(offset)]);
  return { users:result.rows.slice(0,50),hasMore:result.rows.length>50 };
};
