// READ-ONLY: why did sally's scheduled agent stop? (correct columns)
import pg from 'pg';
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const q = async (sql, p) => (await c.query(sql, p)).rows;
const AG = 'cmnwioug2000004jrb45jzzo0';

console.log('=== SCHEDULES ===');
const sch = await q(`select schedule_id, type, status, cron_expression, run_at, session_mode,
  created_by, last_run_at, next_run_at, run_count, consecutive_errors, last_error, delivery
  from schedules where agent_id=$1 order by last_run_at desc nulls last`, [AG]);
for (const s of sch) {
  console.log(JSON.stringify(s, null, 2));
  // does created_by still exist / resolve?
  if (s.created_by) {
    const u = await q(`select user_id, name, merged_into from users where user_id=$1`, [s.created_by]);
    const role = await q(`select role from user_agents where agent_id=$1 and user_id=$2`, [AG, s.created_by]);
    console.log(`  created_by ${s.created_by} -> user:${JSON.stringify(u)} roleOnAgent:${JSON.stringify(role)}`);
  }
}

console.log('\n=== LAST 15 session_events (any session) ===');
const ev = await q(`select session_id, ts, event_type, left(coalesce(content,''),160) as content
  from session_events where agent_id=$1 order by ts desc limit 15`, [AG]);
for (const e of ev) console.log(`  ${e.ts} [${e.event_type}] (${e.session_id}) ${e.content?.replace(/\n/g,' ')}`);

console.log('\n=== channel_credentials health (amiko provider) ===');
const cr = await q(`select channel_type, enabled, consecutive_failure_count, total_failure_count, last_error, last_error_at, last_success_at
  from agent_channels where agent_id=$1`, [AG]).catch(e=>{console.log('(agent_channels q err)',e.message);return[];});
for (const r of cr) console.log('  ', JSON.stringify(r));

await c.end();
