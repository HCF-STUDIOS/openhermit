// READ-ONLY: sally cmmkilrrg — raw error-event payloads + runtime provider/model + latest events now.
import pg from 'pg';
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const q = async (sql, p) => (await c.query(sql, p)).rows;
const AG = 'cmmkilrrg0006js04zomqi1r3';

console.log('=== current model config ===');
const a = (await q(`select config_json, updated_at from agents where agent_id=$1`,[AG]))[0];
let cfg=a.config_json; try{cfg=typeof cfg==='string'?JSON.parse(cfg):cfg;}catch{}
console.log('model:', JSON.stringify(cfg?.model), '| updated:', a.updated_at);

console.log('\n=== ALL error events last 3 days (full content + payload) ===');
for (const e of await q(`select session_id, ts, left(coalesce(content,''),400) content, payload
   from session_events where agent_id=$1 and event_type='error' and ts > '2026-10-11' order by ts desc limit 40`,[AG])) {
  console.log(`\n  [${e.ts}] (${e.session_id})`);
  console.log('   content:', (e.content||'').replace(/\n/g,' '));
  console.log('   payload:', typeof e.payload==='object'?JSON.stringify(e.payload).slice(0,700):String(e.payload).slice(0,700));
}

console.log('\n=== runtime provider/model from recent assistant/agent events (payload hints) ===');
for (const e of await q(`select ts, event_type, payload from session_events
   where agent_id=$1 and payload is not null and ts > '2026-10-12' order by ts desc limit 60`,[AG])) {
  const p=e.payload; if(!p||typeof p!=='object') continue;
  const h={}; for(const k of Object.keys(p)) if(/model|provider|usage|error|status|code/i.test(k)) h[k]=p[k];
  if(Object.keys(h).length) console.log(`  ${e.ts} [${e.event_type}] ${JSON.stringify(h).slice(0,300)}`);
}

console.log('\n=== events today after 09:15 (any new?) ===');
for (const e of await q(`select session_id, count(*)::int n, min(ts) first, max(ts) last
   from session_events where agent_id=$1 and ts > '2026-10-13T09:15' group by session_id order by last desc`,[AG]))
  console.log('  ', JSON.stringify(e));

console.log('\n=== absolute latest 12 events ===');
for (const e of await q(`select session_id, ts, event_type, left(coalesce(content,''),100) content
   from session_events where agent_id=$1 order by ts desc limit 12`,[AG]))
  console.log(`  ${e.ts} [${e.event_type}] (${e.session_id}) ${(e.content||'').replace(/\n/g,' ')}`);
await c.end();
