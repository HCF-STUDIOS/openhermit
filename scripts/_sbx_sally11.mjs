// READ-ONLY: all agents named sally + any avatar/image field we can find.
import pg from 'pg';
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const q = async (sql, p) => (await c.query(sql, p)).rows;

const agents = await q(`select agent_id, name, status, created_at, updated_at, config_json from agents where name ilike 'sally' order by created_at`);
console.log(`found ${agents.length} agents named "sally":\n`);
for (const a of agents) {
  let cfg = a.config_json; try { cfg = typeof cfg==='string'?JSON.parse(cfg):cfg; } catch {}
  const owner = await q(`select user_id from user_agents where agent_id=$1 and role='owner'`, [a.agent_id]);
  const last = await q(`select max(ts) m from session_events where agent_id=$1`, [a.agent_id]);
  // hunt for avatar-ish keys anywhere in config
  const blob = JSON.stringify(cfg||{});
  const avatarKeys = {};
  const scan = (o, path='') => { if (o && typeof o==='object') for (const k of Object.keys(o)) { const np = path?path+'.'+k:k; if (/avatar|image|photo|picture|icon|portrait|head/i.test(k)) avatarKeys[np]=o[k]; else scan(o[k], np); } };
  scan(cfg);
  console.log(`agent_id: ${a.agent_id}`);
  console.log(`  owner: ${JSON.stringify(owner.map(o=>o.user_id))}  status: ${a.status}  lastEvent: ${last[0].m}`);
  console.log(`  created: ${a.created_at?.toISOString?.()}`);
  console.log(`  avatar-ish fields in config: ${JSON.stringify(avatarKeys)}`);
  // also owner user avatar
  if (owner[0]) {
    const u = (await q(`select * from users where user_id=$1`, [owner[0].user_id]))[0];
    const ub = JSON.stringify(u);
    const uav = {}; for (const k of Object.keys(u)) if (/avatar|image|photo|picture|icon/i.test(k)) uav[k]=u[k];
    console.log(`  owner user avatar fields: ${JSON.stringify(uav)}`);
  }
  console.log('');
}

// what columns does users table have (to know where avatar might live)
console.log('users columns:', (await q(`select column_name from information_schema.columns where table_schema='public' and table_name='users'`)).map(r=>r.column_name).join(', '));
console.log('agents columns:', (await q(`select column_name from information_schema.columns where table_schema='public' and table_name='agents'`)).map(r=>r.column_name).join(', '));
await c.end();
