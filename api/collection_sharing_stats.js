// Read-only analytics. Mounted behind the existing admin authentication middleware.
module.exports = async function sharingStats(db, { days = '30', albumId = '' } = {}) {
  if (!['7','30','90','all'].includes(String(days)) || (albumId && !/^[1-9]\d*$/.test(String(albumId)))) {
    const error = new Error('Choose a valid period and album.'); error.status = 400; throw error;
  }
  const params = [days === 'all' ? null : Number(days), albumId ? Number(albumId) : null];
  const base = `WITH links AS (SELECT * FROM collection_invitations WHERE ($2::int IS NULL OR album_id=$2)),
    signups AS (SELECT v.*,i.owner_id,i.album_id FROM collection_invitation_visitors v JOIN links i ON i.id=v.invitation_id
      WHERE v.new_signup AND ($1::int IS NULL OR v.created_at >= now()-make_interval(days=>$1))),
    new_links AS (SELECT * FROM links WHERE $1::int IS NULL OR created_at >= now()-make_interval(days=>$1))`;
  const [totals, albums, daily, leaders, choices] = await Promise.all([
    db.query(base+` SELECT
      (SELECT count(*)::int FROM new_links) AS links_created,
      (SELECT count(*)::int FROM links WHERE active) AS active_links,
      (SELECT count(DISTINCT owner_id)::int FROM new_links) AS sharers,
      (SELECT count(*)::int FROM signups) AS signups,
      (SELECT count(*)::int FROM signups WHERE qualified_at IS NOT NULL) AS qualified,
      (SELECT count(DISTINCT b.user_id)::int FROM user_badges b JOIN links i ON i.owner_id=b.user_id WHERE b.badge_type='community_builder') AS badge_holders`, params),
    db.query(base+` SELECT a.id,a.name,
      (SELECT count(*)::int FROM new_links i WHERE i.album_id=a.id) AS links_created,
      (SELECT count(*)::int FROM signups s WHERE s.album_id=a.id) AS signups,
      (SELECT count(*)::int FROM signups s WHERE s.album_id=a.id AND qualified_at IS NOT NULL) AS qualified
      FROM albums a WHERE $2::int IS NULL OR a.id=$2 ORDER BY a.id`,params),
    db.query(base+` SELECT day,sum(links)::int AS links,sum(signups)::int AS signups FROM (
      SELECT to_char(created_at AT TIME ZONE 'Europe/London','YYYY-MM-DD') AS day,count(*) AS links,0 AS signups FROM new_links GROUP BY 1
      UNION ALL SELECT to_char(created_at AT TIME ZONE 'Europe/London','YYYY-MM-DD'),0,count(*) FROM signups GROUP BY 1
    ) events GROUP BY day ORDER BY day`,params),
    db.query(base+` SELECT u.id,u.name,count(*)::int AS signups,count(*) FILTER(WHERE s.qualified_at IS NOT NULL)::int AS qualified
      FROM signups s JOIN users u ON u.id=s.owner_id GROUP BY u.id,u.name ORDER BY signups DESC,qualified DESC,u.id LIMIT 10`,params),
    db.query('SELECT id,name FROM albums ORDER BY id')
  ]);
  return {totals:totals.rows[0],albums:albums.rows,daily:daily.rows,leaders:leaders.rows,albumChoices:choices.rows};
};
