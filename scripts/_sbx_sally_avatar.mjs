// READ-ONLY: amiko DB — twins named sally, avatar + openhermit linkage.
import pg from 'pg';
const c = new pg.Client({ connectionString: process.env.AMIKO_DB });
await c.connect();
const q = async (sql, p) => (await c.query(sql, p)).rows;

const rows = await q(`
  select t.id, t.user_id, t.name, t.avatar_url, t.original_photo_url,
         t.clawd_id, t.clawd_service_id, t.openclaw_agent_id, t.is_public, t.created_at,
         u.name as owner_name, u.handle as owner_handle, u.email as owner_email, u.tier
  from amiko.twins t left join amiko.users u on u.id = t.user_id
  where t.name ilike 'sally'
  order by t.created_at`);
console.log(`found ${rows.length} amiko twins named sally:\n`);
for (const r of rows) {
  console.log(JSON.stringify(r, null, 2));
  console.log('---');
}
await c.end();
