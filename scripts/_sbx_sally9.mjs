// READ-ONLY: resolve ALL agents tied to Sally + most recent event per agent (did ANY see today's msg?).
import pg from 'pg';
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const q = async (sql, p) => (await c.query(sql, p)).rows;
const SALLY_USER = 'usr-5023b9ec706f';

console.log('=== agents where sally has ANY role ===');
const mem = await q(`select ua.agent_id, ua.role, a.name, a.status from user_agents ua left join agents a on a.agent_id=ua.agent_id where ua.user_id=$1`, [SALLY_USER]);
for (const m of mem) {
  const last = await q(`select max(ts) m, count(*)::int n from session_events where agent_id=$1`, [m.agent_id]);
  const today = await q(`select count(*)::int n from session_events where agent_id=$1 and ts > '2026-10-12'`, [m.agent_id]);
  const sch = await q(`select count(*)::int n from schedules where agent_id=$1`, [m.agent_id]);
  console.log(`  ${m.agent_id} name=${m.name} role=${m.role} status=${m.status} | lastEvent=${last[0].m} totalEvents=${last[0].n} eventsSince10-12=${today[0].n} schedules=${sch[0].n}`);
}

console.log('\n=== all agents named like sally ===');
for (const a of await q(`select agent_id, name, status from agents where name ilike '%sally%'`)) {
  const last = await q(`select max(ts) m from session_events where agent_id=$1`, [a.agent_id]);
  const owner = await q(`select user_id from user_agents where agent_id=$1 and role='owner'`, [a.agent_id]);
  console.log(`  ${a.agent_id} name=${a.name} status=${a.status} owner=${JSON.stringify(owner.map(o=>o.user_id))} lastEvent=${last[0].m}`);
}

// any session_events anywhere today containing "充值" (today's recharge msg), to see where it landed
console.log('\n=== events since 10-12 mentioning 充值/已经充值 (any agent) ===');
for (const e of await q(`select agent_id, session_id, ts, event_type, left(coalesce(content,''),120) content from session_events where ts > '2026-10-12' and content ilike '%充值%' limit 20`))
  console.log('  ', JSON.stringify(e));

await c.end();
