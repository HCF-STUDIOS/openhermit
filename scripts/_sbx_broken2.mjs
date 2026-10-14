// READ-ONLY openhermit: deep compare the 2 broken twins.
import pg from 'pg';
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const q = async (s,p)=>(await c.query(s,p)).rows;
const BROKEN = [["cmv465akm000007l5nedpujvs","勋哥"],["cmv65sb2g000007jqrr2w3571","Nicky"]];

for (const [id,name] of BROKEN) {
  console.log(`\n===== ${name} (${id}) =====`);
  const a = (await q(`select name, created_at, updated_at, status, backend_state, config_json, security_json from openhermit.agents where agent_id=$1`,[id]))[0];
  if(!a){console.log('  NO openhermit agent row'); continue;}
  const cfg=JSON.parse(a.config_json||'{}');
  console.log('  OH agent created:', a.created_at, '| updated:', a.updated_at, '| status:', a.status, '| backend_state:', a.backend_state);
  console.log('  model:', JSON.stringify(cfg.model), '| access:', a.security_json);
  console.log('  owner rows:', JSON.stringify(await q(`select user_id, role from openhermit.user_agents where agent_id=$1`,[id])));
  console.log('  sessions:', JSON.stringify(await q(`select session_id, type, status, message_count from openhermit.sessions where agent_id=$1`,[id])));
  console.log('  sandbox:', JSON.stringify(await q(`select status, external_id is not null ext, last_seen_at from openhermit.sandboxes where agent_id=$1`,[id])));
  console.log('  total events:', (await q(`select count(*)::int n from openhermit.session_events where agent_id=$1`,[id]))[0].n);
  console.log('  instructions seeded:', (await q(`select count(*)::int n from openhermit.instructions where agent_id=$1`,[id]))[0].n);
}
await c.end();
