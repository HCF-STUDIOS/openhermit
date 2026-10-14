// READ-ONLY: locate twin "nicky" and inspect recent activity / errors.
import pg from 'pg';
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const q = async (sql, p) => (await c.query(sql, p)).rows;

const acols = await q(`select column_name from information_schema.columns where table_schema='openhermit' and table_name='agents' order by ordinal_position`);
console.log('agents columns:', acols.map(x=>x.column_name).join(', '));

console.log('\n=== agents named like nicky ===');
const agents = await q(`select * from openhermit.agents where name ilike '%nicky%' order by name limit 20`);
for (const a of agents) console.log(JSON.stringify(a));

if (!agents.length) { console.log('none found'); await c.end(); process.exit(0); }

for (const a of agents) {
  const AG = a.agent_id;
  console.log(`\n========== agent ${AG} (${a.name}) ==========`);
  const cfg = JSON.parse(a.config_json||'{}');
  console.log('model:', JSON.stringify(cfg.model), '| access:', a.security_json, '| status:', a.status);

  console.log('--- last 12 events overall ---');
  for (const e of await q(`select ts, event_type, session_id, left(coalesce(content,''),80) content from openhermit.session_events where agent_id=$1 order by ts desc limit 12`,[AG]))
    console.log(`  ${e.ts} ${e.event_type} (${e.session_id}) ${(e.content||'').replace(/\n/g,' ')}`);

  console.log('--- error events last 7d ---');
  const errs = await q(`select ts, session_id, left(coalesce(content,''),160) content from openhermit.session_events where agent_id=$1 and event_type='error' and ts > '2026-10-07' order by ts desc limit 30`,[AG]);
  if (!errs.length) console.log('  (none)');
  for (const e of errs) console.log(`  ${e.ts} (${e.session_id}) ${(e.content||'').replace(/\n/g,' ')}`);

  console.log('--- latest assistant turns ---');
  for (const e of await q(`select ts, payload from openhermit.session_events where agent_id=$1 and event_type='assistant' and payload is not null order by ts desc limit 6`,[AG])) {
    const p=e.payload||{};
    console.log(`  ${e.ts} stop=${p.stopReason} provider=${p.provider} cost=${p.usage?.cost?.total ?? p.usage?.cost ?? '?'} err=${p.errorMessage?String(p.errorMessage).slice(0,120):''}`);
  }

  console.log('--- now ---', (await q(`select now() n`))[0].n);
}
await c.end();
