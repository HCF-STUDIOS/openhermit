// READ-ONLY: definitively establish Sally's provider + whether any minimax/own-key exists anywhere.
import pg from 'pg';
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const q = async (sql, p) => (await c.query(sql, p)).rows;
const AG = 'cmnwioug2000004jrb45jzzo0';

const a = (await q(`select config_json, security_json, updated_at, backend_state from agents where agent_id=$1`, [AG]))[0];
let cfg = a.config_json; try { cfg = typeof cfg==='string'?JSON.parse(cfg):cfg; } catch {}
let sec = a.security_json; try { sec = typeof sec==='string'?JSON.parse(sec):sec; } catch {}
console.log('agent config updated_at:', a.updated_at?.toISOString?.() ?? a.updated_at);
console.log('MODEL BLOCK:', JSON.stringify(cfg?.model, null, 2));
console.log('full security_json:', JSON.stringify(sec, null, 2));
console.log('backend_state:', typeof a.backend_state === 'object' ? JSON.stringify(a.backend_state).slice(0,500) : a.backend_state);

// Any table holding per-agent secrets / keys?
console.log('\n=== tables with "secret" or "key" or "credential" in name ===');
for (const t of await q(`select table_name from information_schema.tables where table_schema='public' and (table_name ilike '%secret%' or table_name ilike '%credential%' or table_name ilike '%key%' or table_name ilike '%provider%')`))
  console.log('  ', t.table_name);

// Search whole config/security for minimax / any provider key hints
const blob = JSON.stringify({cfg, sec}).toLowerCase();
console.log('\nmentions "minimax" anywhere in config/security:', blob.includes('minimax'));
console.log('mentions "api_key"/"apikey":', blob.includes('api_key') || blob.includes('apikey'));
console.log('mentions "deepseek":', blob.includes('deepseek'));

// Does the agent_channels / any row reference minimax for this agent?
console.log('\n=== grep session_events payloads for the actual provider/model used at runtime (last real run 7/29) ===');
for (const e of await q(`select ts, event_type, payload from session_events where agent_id=$1 and event_type in ('agent_start','agent_end','assistant') and payload is not null order by ts desc limit 3`, [AG])) {
  const p = e.payload;
  const hint = {};
  if (p && typeof p==='object') for (const k of Object.keys(p)) if (/model|provider|usage|cost|token/i.test(k)) hint[k]=p[k];
  console.log(`  ${e.ts} [${e.event_type}] ${JSON.stringify(hint).slice(0,400)}`);
}
await c.end();
