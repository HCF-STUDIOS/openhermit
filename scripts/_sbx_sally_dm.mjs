// READ-ONLY: DM session amiko:cmmkiu6cq timeline around the two screenshot messages (UTC 07:00-09:15).
import pg from 'pg';
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const q = async (sql, p) => (await c.query(sql, p)).rows;
const AG='cmmkilrrg0006js04zomqi1r3', S='amiko:cmmkiu6cq0000lb04cupxbn3y';
console.log('=== DM session events 2026-10-13 07:00 .. 09:15 UTC (= 15:00..17:15 Beijing) ===');
for (const e of await q(`select ts, event_type, left(coalesce(content,''),160) content
   from session_events where agent_id=$1 and session_id=$2
   and ts >= '2026-10-13T07:00' and ts <= '2026-10-13T09:15' order by ts asc`,[AG,S]))
  console.log(`  ${e.ts} [${e.event_type}] ${(e.content||'').replace(/\n/g,' ')}`);
console.log('\n=== last user message + last assistant in this DM session overall ===');
for (const t of ['user','assistant','error']) {
  const r=(await q(`select ts, left(coalesce(content,''),160) content from session_events where agent_id=$1 and session_id=$2 and event_type=$3 order by ts desc limit 1`,[AG,S,t]))[0];
  console.log(`  last ${t}:`, r?`${r.ts} — ${(r.content||'').replace(/\n/g,' ')}`:'none');
}
await c.end();
