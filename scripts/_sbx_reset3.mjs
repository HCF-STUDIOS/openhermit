// Full "from scratch" reset for re-testing the wechat authorize -> enable ->
// first-contact owner-claim flow. Removes owner's wechat identity, all wechat
// sessions+events, and DISABLES the channel (keeps row + token; reversible).
// DRY-RUN unless CONFIRM=yes. Does NOT touch other users' wechat identities.
import pg from 'pg';
const AGENT = 'cmewkyjkh0002ld04ydjqh3pq';
const OWNER = 'usr-e334d575b366';
const WX = 'o9cq804c8lCFs2mlC7igP2j6VkQ4@im.wechat';
const CHAN = 'chr-15c48f485ccde1c2';
const LIVE = process.env.CONFIRM === 'yes';
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const q = async (sql, p) => (await c.query(sql, p)).rows;

// owner's wechat identity (what we remove)
const ownerWx = await q(`select channel_user_id from user_identities where user_id=$1 and channel='wechat'`, [OWNER]);
// all wechat/weixin sessions for this agent
const sess = await q(`select session_id, source_platform, message_count, user_ids from sessions where agent_id=$1 and (source_platform ilike '%wechat%' or source_platform ilike '%weixin%') order by created_at`, [AGENT]);
let evTotal = 0;
for (const s of sess) { const n=(await q(`select count(*)::int n from session_events where agent_id=$1 and session_id=$2`,[AGENT,s.session_id]))[0].n; s.events=n; evTotal+=n; }
const chan = await q(`select id, enabled from agent_channels where id=$1`, [CHAN]);

console.log('PLAN:');
console.log(`  owner wechat identities to delete: ${JSON.stringify(ownerWx)}`);
console.log(`  wechat sessions to delete: ${sess.length} (events ${evTotal})`);
for (const s of sess) console.log(`    - ${s.session_id} [${s.source_platform}] users=${JSON.stringify(s.user_ids)} events=${s.events}`);
console.log(`  channel ${CHAN} enabled ${chan[0]?.enabled} -> false`);

if (!LIVE) { console.log('\nDRY-RUN — no changes. CONFIRM=yes to apply.'); await c.end(); process.exit(0); }

await c.query('begin');
try {
  for (const s of sess) {
    await c.query(`delete from session_events where agent_id=$1 and session_id=$2`, [AGENT, s.session_id]);
    await c.query(`delete from sessions where agent_id=$1 and session_id=$2`, [AGENT, s.session_id]);
  }
  await c.query(`delete from user_identities where user_id=$1 and channel='wechat' and channel_user_id=$2`, [OWNER, WX]);
  await c.query(`update agent_channels set enabled=false where id=$1`, [CHAN]);
  await c.query('commit');
  console.log('\n[LIVE] reset committed.');
} catch (e) { await c.query('rollback'); console.log('ROLLED BACK:', e.message); process.exitCode=1; }

console.log('VERIFY your wechat resolves to:', (await q(`select user_id from user_identities where channel='wechat' and channel_user_id=$1`,[WX]))[0]?.user_id || 'NOBODY (good)');
console.log('VERIFY owner wechat ids:', (await q(`select count(*)::int n from user_identities where user_id=$1 and channel='wechat'`,[OWNER]))[0].n);
console.log('VERIFY wechat sessions:', (await q(`select count(*)::int n from sessions where agent_id=$1 and (source_platform ilike '%wechat%' or source_platform ilike '%weixin%')`,[AGENT]))[0].n);
console.log('VERIFY channel enabled:', (await q(`select enabled from agent_channels where id=$1`,[CHAN]))[0].enabled);
await c.end();
console.log('--- done ---');
