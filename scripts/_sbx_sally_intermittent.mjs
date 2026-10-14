// READ-ONLY: characterize sally's intermittency — success vs error assistant turns by hour, today + yesterday.
import pg from 'pg';
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const q = async (sql, p) => (await c.query(sql, p)).rows;
const AG='cmmkilrrg0006js04zomqi1r3';

console.log('=== ALL error events last 36h (full content) ===');
for (const e of await q(`select session_id, ts, left(coalesce(content,''),120) content
   from session_events where agent_id=$1 and event_type='error' and ts > '2026-10-12T00:00' order by ts desc limit 60`,[AG]))
  console.log(`  ${e.ts} (${e.session_id}) ${(e.content||'').replace(/\n/g,' ')}`);

console.log('\n=== assistant turns: success(has usage) vs error(stopReason=error) per hour, last 36h ===');
const rows = await q(`
  select to_char(date_trunc('hour', ts::timestamptz), 'MM-DD HH24') hr,
    count(*) filter (where (payload->>'stopReason') is distinct from 'error' and payload ? 'usage') success,
    count(*) filter (where payload->>'stopReason' = 'error') errored
  from session_events
  where agent_id=$1 and event_type='assistant' and ts > '2026-10-12T00:00'
  group by 1 order by 1`, [AG]);
for (const r of rows) console.log(`  ${r.hr}:00  ok=${r.success}  err=${r.errored}`);

console.log('\n=== latest 8 assistant events with stopReason/provider/cost ===');
for (const e of await q(`select ts, payload from session_events where agent_id=$1 and event_type='assistant' and payload is not null order by ts desc limit 8`,[AG])) {
  const p=e.payload||{};
  console.log(`  ${e.ts} stop=${p.stopReason} provider=${p.provider} cost=${p.usage?.cost?.total ?? p.usage?.cost ?? '?'} err=${p.errorMessage?String(p.errorMessage).slice(0,90):''}`);
}

console.log('\n=== current time + latest event overall ===');
console.log('  now:', (await q(`select now() n`))[0].n);
const last=(await q(`select ts, event_type, session_id from session_events where agent_id=$1 order by ts desc limit 1`,[AG]))[0];
console.log('  last event:', last.ts, last.event_type, last.session_id);
await c.end();
