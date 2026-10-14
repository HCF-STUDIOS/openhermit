// Clean ONLY William's own wechat test artifacts on Will, so a fresh DM hits
// link-to-owner. Does NOT touch the 7 other users' wechat identities (the
// owner-scoped guard fix makes those irrelevant). DRY-RUN unless CONFIRM=yes.
import pg from 'pg';
const AGENT = 'cmewkyjkh0002ld04ydjqh3pq';
const GUEST = 'usr-mv5700w4';                              // pure-wechat test guest
const WX = 'o9cq804c8lCFs2mlC7igP2j6VkQ4@im.wechat';       // William's own wechat
const SESSIONS = ['wechat:2026-10-12-d7c6fc4c', '56af52db-10ff-4bcd-b954-7d0ff17ce1d5'];
const OWNER = 'usr-e334d575b366';
const LIVE = process.env.CONFIRM === 'yes';
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const q = async (sql, p) => (await c.query(sql, p)).rows;
const n = async (sql, p) => (await q(sql, p))[0].n;

// safety: GUEST must be pure-wechat artifact
const gIds = await q(`select channel, channel_user_id from user_identities where user_id=$1`, [GUEST]);
const gMemb = await q(`select agent_id, role from user_agents where user_id=$1`, [GUEST]);
const gSched = await n(`select count(*)::int n from schedules where created_by=$1`, [GUEST]);
console.log(`GUEST ${GUEST}: identities=${JSON.stringify(gIds)} memberships=${JSON.stringify(gMemb)} scheds=${gSched}`);
const pure = gIds.every(i=>i.channel==='wechat') && gMemb.every(m=>m.agent_id===AGENT) && gSched===0;
if (!pure) { console.log('ABORT: guest is not a pure-wechat artifact'); await c.end(); process.exit(1); }

const evForSess = {};
let evTotal = 0;
for (const s of SESSIONS) { const e = await n(`select count(*)::int n from session_events where agent_id=$1 and session_id=$2`,[AGENT,s]); evForSess[s]=e; evTotal+=e; }
console.log(`\nDELETE plan:`);
console.log(`  user ${GUEST} (+ its membership + wechat identity ${WX})`);
console.log(`  sessions: ${JSON.stringify(evForSess)} (events total ${evTotal})`);
console.log(`\nAfter: resolve('wechat','${WX}') should be NOBODY (currently -> ${await q(`select user_id from user_identities where channel='wechat' and channel_user_id=$1`,[WX]).then(r=>r[0]?.user_id||'none')})`);
console.log(`Owner ${OWNER} wechat identities (must stay 0): ${await n(`select count(*)::int n from user_identities where user_id=$1 and channel='wechat'`,[OWNER])}`);

if (!LIVE) { console.log('\nDRY-RUN — no changes. CONFIRM=yes to apply.'); await c.end(); process.exit(0); }

await c.query('begin');
try {
  for (const s of SESSIONS) {
    await c.query(`delete from session_events where agent_id=$1 and session_id=$2`, [AGENT, s]);
    await c.query(`delete from sessions where agent_id=$1 and session_id=$2`, [AGENT, s]);
  }
  await c.query(`delete from user_identities where channel='wechat' and channel_user_id=$1 and user_id=$2`, [WX, GUEST]);
  await c.query(`delete from user_agents where user_id=$1`, [GUEST]);
  await c.query(`delete from users where user_id=$1`, [GUEST]);
  await c.query('commit');
  console.log('\n[LIVE] cleanup committed.');
} catch (e) { await c.query('rollback'); console.log('ROLLED BACK:', e.message); process.exitCode=1; }

console.log('VERIFY resolve:', await q(`select user_id from user_identities where channel='wechat' and channel_user_id=$1`,[WX]).then(r=>r[0]?.user_id||'NOBODY (good)'));
console.log('VERIFY guest row:', await q(`select user_id from users where user_id=$1`,[GUEST]).then(r=>r[0]?'STILL EXISTS (bad)':'deleted (good)'));
console.log('VERIFY Will owners:', JSON.stringify(await q(`select user_id,role from user_agents where agent_id=$1 and role='owner'`,[AGENT])));
await c.end();
console.log('--- done ---');
