// READ-ONLY: the REAL sally twin = cmmkilrrg… — model/provider, schedule, recent events incl. 额度 errors.
import pg from 'pg';
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const q = async (sql, p) => (await c.query(sql, p)).rows;
const AG = 'cmmkilrrg0006js04zomqi1r3';

const a = (await q(`select config_json, security_json, status, updated_at from agents where agent_id=$1`, [AG]))[0];
let cfg = a.config_json; try { cfg = typeof cfg==='string'?JSON.parse(cfg):cfg; } catch {}
let sec = a.security_json; try { sec = typeof sec==='string'?JSON.parse(sec):sec; } catch {}
console.log('status:', a.status, '| config updated:', a.updated_at?.toISOString?.());
console.log('MODEL:', JSON.stringify(cfg?.model));
console.log('security_json:', JSON.stringify(sec));
const blob = JSON.stringify({cfg,sec}).toLowerCase();
console.log('has minimax:', blob.includes('minimax'), '| has api_key:', blob.includes('api_key')||blob.includes('apikey'));

console.log('\n=== schedules ===');
for (const s of await q(`select schedule_id, status, cron_expression, last_run_at, next_run_at, run_count, consecutive_errors, left(coalesce(last_error,''),200) err from schedules where agent_id=$1`, [AG]))
  console.log('  ', JSON.stringify(s));

console.log('\n=== last 25 events ===');
for (const e of await q(`select session_id, ts, event_type, left(coalesce(content,''),140) content from session_events where agent_id=$1 order by ts desc limit 25`, [AG]))
  console.log(`  ${e.ts} [${e.event_type}] (${e.session_id}) ${(e.content||'').replace(/\n/g,' ')}`);

console.log('\n=== error events in last 7 days ===');
for (const e of await q(`select session_id, ts, left(coalesce(content,''),160) content from session_events where agent_id=$1 and event_type='error' and ts > '2026-10-06' order by ts desc limit 20`, [AG]))
  console.log(`  ${e.ts} (${e.session_id}) ${(e.content||'').replace(/\n/g,' ')}`);

console.log('\n=== any events today (10-13)? count + sessions ===');
for (const e of await q(`select session_id, count(*)::int n, min(ts) first, max(ts) last from session_events where agent_id=$1 and ts > '2026-10-13' group by session_id order by last desc`, [AG]))
  console.log('  ', JSON.stringify(e));
await c.end();
