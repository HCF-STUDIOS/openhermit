// READ-ONLY: deep-dive both sally agents + sally user.
import pg from 'pg';
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const q = async (sql, p) => (await c.query(sql, p)).rows;
const AGENTS = ['cmnwioug2000004jrb45jzzo0', 'cmmkilrrg0006js04zomqi1r3'];
const SALLY_USER = 'usr-5023b9ec706f';

console.log('=== sally user memberships ===');
for (const m of await q(`select ua.agent_id, ua.role, a.name from user_agents ua left join agents a on a.agent_id=ua.agent_id where ua.user_id=$1`, [SALLY_USER]))
  console.log(' ', JSON.stringify(m));
console.log('sally user identities:', JSON.stringify(await q(`select channel, channel_user_id from user_identities where user_id=$1`, [SALLY_USER])));

for (const AG of AGENTS) {
  console.log(`\n\n########## AGENT ${AG} ##########`);
  const a = (await q(`select agent_id, name, status, backend_state, updated_at, config_json, security_json from agents where agent_id=$1`, [AG]))[0];
  console.log('status:', a.status, '| backend_state:', a.backend_state, '| updated:', a.updated_at?.toISOString?.());
  // model from config
  let model = '?';
  try { const cfg = typeof a.config_json==='string'?JSON.parse(a.config_json):a.config_json; model = cfg?.model || cfg?.agent?.model || JSON.stringify(cfg?.models||cfg?.model||'?').slice(0,120); } catch {}
  console.log('model(config):', model);

  console.log('owners/roster:');
  for (const r of await q(`select role, count(*)::int n from user_agents where agent_id=$1 group by role`, [AG])) console.log('  ', JSON.stringify(r));
  console.log('  owner rows:', JSON.stringify(await q(`select user_id from user_agents where agent_id=$1 and role='owner'`, [AG])));

  console.log('recent sessions:');
  const sess = await q(`select session_id, source_platform, message_count, last_activity_at from sessions where agent_id=$1 order by last_activity_at desc nulls last limit 5`, [AG]);
  for (const s of sess) console.log('  ', JSON.stringify(s));

  // most recent events across the agent
  const ev = await q(`select session_id, type, created_at from session_events where agent_id=$1 order by created_at desc limit 12`, [AG]);
  console.log('last 12 events:');
  for (const e of ev) console.log(`   ${e.created_at?.toISOString?.()} ${e.type} (${e.session_id})`);

  // schedules
  const sch = await q(`select id, created_by, enabled, cron, next_run_at from schedules where agent_id=$1`, [AG]).catch(()=>[]);
  console.log('schedules:', sch.length, JSON.stringify(sch.slice(0,5)));
}
await c.end();
