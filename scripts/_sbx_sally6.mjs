// READ-ONLY, set-based: feed-scan agents that have the session but ZERO schedule rows.
import pg from 'pg';
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const q = async (sql, p) => (await c.query(sql, p)).rows;

const rows = await q(`
  with feed_sess as (
    select agent_id, max(last_activity_at) last_act
    from sessions where session_id like 'schedule:feed-scan%' group by agent_id
  )
  select f.agent_id, f.last_act, a.name, a.status,
         (select count(*)::int from schedules s where s.agent_id=f.agent_id) sched_rows
  from feed_sess f left join agents a on a.agent_id=f.agent_id
  order by f.last_act asc`);

const dead = rows.filter(r => r.sched_rows === 0);
console.log(`feed-scan session agents total: ${rows.length}`);
console.log(`...with ZERO schedule rows (silently dead): ${dead.length}\n`);
for (const d of dead) {
  const owner = await q(`select u.user_id, u.name, u.merged_into from user_agents ua join users u on u.user_id=ua.user_id where ua.agent_id=$1 and ua.role='owner'`, [d.agent_id]);
  console.log(`  last_act=${d.last_act?.toISOString?.()}  ${d.agent_id}  name=${d.name} status=${d.status}  owner=${JSON.stringify(owner)}`);
}

console.log('\n=== sally user ===');
console.log(JSON.stringify(await q(`select user_id, name, merged_into, created_at from users where user_id='usr-5023b9ec706f'`)));
console.log('merged INTO sally:', JSON.stringify(await q(`select user_id, name from users where merged_into='usr-5023b9ec706f'`)));
await c.end();
