// READ-ONLY: investigate Will's 2 owners. No writes.
import pg from 'pg';
const AGENT_ID = 'cmewkyjkh0002ld04ydjqh3pq';
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const q = async (sql, p) => (await c.query(sql, p)).rows;

const owners = await q(`select user_id, role, created_at from user_agents where agent_id=$1 and role='owner' order by created_at`, [AGENT_ID]);
console.log(`WILL OWNERS: ${owners.length}`);
for (const o of owners) {
  const ids = await q(`select channel, channel_user_id, created_at from user_identities where user_id=$1 order by created_at`, [o.user_id]);
  const nMemb = (await q(`select count(*)::int n from user_agents where user_id=$1`, [o.user_id]))[0].n;
  const nSched = (await q(`select count(*)::int n from schedules where created_by=$1`, [o.user_id]))[0].n;
  const ownsAgents = await q(`select agent_id from user_agents where user_id=$1 and role='owner'`, [o.user_id]);
  console.log(`\n== OWNER ${o.user_id}  joinedWill=${o.created_at?.toISOString?.()||o.created_at}`);
  console.log(`   memberships=${nMemb} schedules=${nSched} ownsAgents=${ownsAgents.length} [${ownsAgents.map(a=>a.agent_id).join(', ')}]`);
  console.log(`   identities (${ids.length}):`);
  for (const i of ids) console.log(`     ${i.channel} :: ${i.channel_user_id}  (${i.created_at?.toISOString?.()||i.created_at})`);
}

// agent row: is there an ownerUserId / creator field on the agent itself?
const agent = await q(`select * from agents where id=$1`, [AGENT_ID]);
if (agent[0]) {
  const a = agent[0];
  const keys = Object.keys(a).filter(k => /owner|user|creator|created_by/i.test(k));
  console.log(`\nAGENT row owner-ish fields:`, JSON.stringify(Object.fromEntries(keys.map(k=>[k,a[k]]))));
  console.log(`AGENT name/handle:`, JSON.stringify({ name: a.name, handle: a.handle, slug: a.slug }));
}

await c.end();
console.log('\n--- done (no writes) ---');
