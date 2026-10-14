// READ-ONLY: Sally's model/provider config + today's inbound-message error payloads.
import pg from 'pg';
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const q = async (sql, p) => (await c.query(sql, p)).rows;
const AG = 'cmnwioug2000004jrb45jzzo0';

const a = (await q(`select config_json, security_json from agents where agent_id=$1`, [AG]))[0];
let cfg = a.config_json; try { cfg = typeof cfg==='string'?JSON.parse(cfg):cfg; } catch {}
let sec = a.security_json; try { sec = typeof sec==='string'?JSON.parse(sec):sec; } catch {}
console.log('=== model config ===');
console.log('model:', JSON.stringify(cfg?.model ?? cfg?.agent?.model));
console.log('provider-ish keys in config:', JSON.stringify(Object.keys(cfg||{})));
console.log('full config_json:', JSON.stringify(cfg, null, 2).slice(0, 2000));
// mask secrets but show which keys exist
const secKeys = sec && typeof sec==='object' ? Object.keys(sec) : [];
console.log('security_json keys:', JSON.stringify(secKeys));
if (sec?.secrets) console.log('secret names:', JSON.stringify(Object.keys(sec.secrets)));
if (sec?.env) console.log('env names:', JSON.stringify(Object.keys(sec.env)));

console.log('\n=== most recent 30 events (any session), today-ish ===');
const ev = await q(`select session_id, ts, event_type, left(coalesce(content,''),400) content, payload
  from session_events where agent_id=$1 order by ts desc limit 30`, [AG]);
for (const e of ev) {
  let extra = '';
  if (e.payload && typeof e.payload==='object') {
    const p = e.payload;
    const err = p.error || p.message || p.lastTurnModelError || p.user_facing || p.text;
    if (err) extra = ' PAYLOAD:' + JSON.stringify(err).slice(0,300);
  }
  console.log(`${e.ts} [${e.event_type}] (${e.session_id}) ${(e.content||'').replace(/\n/g,' ').slice(0,180)}${extra}`);
}
await c.end();
