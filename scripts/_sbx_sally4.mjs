// READ-ONLY: is sally's schedule row gone, reassigned, or disabled?
import pg from 'pg';
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const q = async (sql, p) => (await c.query(sql, p)).rows;
const AG = 'cmnwioug2000004jrb45jzzo0';

console.log('schedules for sally agent:', (await q(`select count(*)::int n from schedules where agent_id=$1`,[AG]))[0].n);
console.log('total schedules in table:', (await q(`select count(*)::int n from schedules`))[0].n);

console.log('\nany schedule with id like feed-scan-comment (across ALL agents):');
for (const r of await q(`select agent_id, schedule_id, status, enabled_note, last_run_at, next_run_at, consecutive_errors, left(coalesce(last_error,''),200) err
  from (select agent_id, schedule_id, status, null as enabled_note, last_run_at, next_run_at, consecutive_errors, last_error from schedules where schedule_id ilike '%feed-scan%' or schedule_id ilike '%comment%') t
  order by last_run_at desc nulls last`))
  console.log('  ', JSON.stringify(r));

console.log('\nsample of 8 live schedules (any agent) to confirm table is active:');
for (const r of await q(`select agent_id, schedule_id, status, last_run_at, next_run_at from schedules order by last_run_at desc nulls last limit 8`))
  console.log('  ', JSON.stringify(r));

// sally agent's sessions that look schedule-driven
console.log('\nsally sessions with "schedule:" prefix:');
for (const r of await q(`select session_id, message_count, last_activity_at from sessions where agent_id=$1 and session_id like 'schedule:%'`,[AG]))
  console.log('  ', JSON.stringify(r));

await c.end();
