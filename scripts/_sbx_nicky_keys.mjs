// READ-ONLY openhermit: Nicky model config + secrets, vs a working amiko/deepseek-flash twin.
import pg from 'pg';
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const q = async (s,p)=>(await c.query(s,p)).rows;

// secrets table columns
const cols = await q(`select column_name from information_schema.columns where table_schema='openhermit' and table_name='agent_secrets' order by ordinal_position`);
console.log('agent_secrets columns:', cols.map(x=>x.column_name).join(', '));

const TW = [["cmv65sb2g000007jqrr2w3571","Nicky (BROKEN)"],["cmv465akm000007l5nedpujvs","勋哥 (BROKEN)"],["cmv6bawgy000707jmrtoqiu2r","幺儿 (WORKING)"],["cmv3xucop000007jykxlh5igz","刘美美 (WORKING)"]];

for (const [id,label] of TW) {
  console.log(`\n===== ${label} =====`);
  const a=(await q(`select config_json from openhermit.agents where agent_id=$1`,[id]))[0];
  const cfg=JSON.parse(a?.config_json||'{}');
  console.log('  model:', JSON.stringify(cfg.model));
  // secrets: show key names + whether value present, NOT the secret value
  const secs = await q(`select * from openhermit.agent_secrets where agent_id=$1`,[id]);
  if(!secs.length) console.log('  secrets: (none)');
  for (const s of secs) {
    const redacted = {};
    for (const [k,v] of Object.entries(s)) {
      if (k==='agent_id') continue;
      if (typeof v==='string' && v.length>8 && /key|secret|token|value|val/i.test(k)) redacted[k]=`<${v.length} chars: ${v.slice(0,4)}…${v.slice(-2)}>`;
      else redacted[k]=v;
    }
    console.log('  secret:', JSON.stringify(redacted));
  }
}

// How does amiko provider auth? check for env-level key names on the gateway (names only)
console.log('\n=== amiko-related env var NAMES present (values hidden) ===');
console.log(Object.keys(process.env).filter(k=>/amiko|deepseek|model|api_key|provider|router/i.test(k)).sort().join(', '));
await c.end();
