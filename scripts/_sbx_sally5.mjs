// READ-ONLY: blast radius — agents that ONCE ran a feed-scan schedule (have the
// session) but now have ZERO rows in `schedules` (silently dead), + sally merge history.
import pg from 'pg';
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const q = async (sql, p) => (await c.query(sql, p)).rows;

// agents with a schedule-driven feed session
const sessAgents = await q(`select distinct agent_id, max(last_activity_at) last_act
  from sessions where session_id like 'schedule:feed-scan%' group by agent_id`);
const dead = [];
for (const r of sessAgents) {
  const n = (await q(`select count(*)::int n from schedules where agent_id=$1`, [r.agent_id]))[0].n;
  if (n === 0) dead.push({ agent_id: r.agent_id, last_act: r.last_act?.toISOString?.() });
}
console.log(`feed-scan session agents total: ${sessAgents.length}`);
console.log(`...of those with ZERO schedule rows (silently dead): ${dead.length}`);
dead.sort((a,b)=>String(a.last_act).localeCompare(String(b.last_act)));
for (const d of dead) {
  const a = (await q(`select name, status from agents where agent_id=$1`,[d.agent_id]))[0];
  const owner = await q(`select user_id from user_agents where agent_id=$1 and role='owner'`,[d.agent_id]);
  console.log(`  ${d.last_act}  ${d.agent_id}  name=${a?.name} status=${a?.status} owners=${JSON.stringify(owner.map(o=>o.user_id))}`);
}

// Sally user merge history
console.log('\n=== sally user merge status ===');
console.log(JSON.stringify(await q(`select user_id, name, merged_into, created_at from users where user_id='usr-5023b9ec706f'`)));
console.log('users merged INTO sally:', JSON.stringify(await q(`select user_id, name from users where merged_into='usr-5023b9ec706f'`)));

await c.end();
