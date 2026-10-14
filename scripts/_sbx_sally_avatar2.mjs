// READ-ONLY: amiko twins by exact id (both sally-candidate agent_ids), incl. deleted.
import pg from 'pg';
const c = new pg.Client({ connectionString: process.env.AMIKO_DB });
await c.connect();
const q = async (sql, p) => (await c.query(sql, p)).rows;
const IDS = ['cmmkilrrg0006js04zomqi1r3', 'cmnwioug2000004jrb45jzzo0'];
for (const id of IDS) {
  const r = (await q(`select t.id, t.name, t.avatar_url, t.deleted_at, t.is_public, t.created_at,
     t.user_id, u.name owner_name, u.handle owner_handle, u.email owner_email
     from amiko.twins t left join amiko.users u on u.id=t.user_id where t.id=$1`, [id]))[0];
  console.log(`agent/twin ${id}:`);
  console.log('  ', r ? JSON.stringify(r) : 'NO amiko twin row with this id');
  console.log('');
}
await c.end();
