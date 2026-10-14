// READ-ONLY: full wechat-linkage inventory for Will. No writes.
import pg from 'pg';
const AGENT_ID = 'cmewkyjkh0002ld04ydjqh3pq';
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const q = async (sql, p) => (await c.query(sql, p)).rows;

// --- channel artifacts ---
const chan = await q(`select id, enabled, token_prefix is not null as has_token from agent_channels where agent_id=$1 and channel_type='wechat'`, [AGENT_ID]);
console.log('CHANNEL agent_channels wechat:', JSON.stringify(chan));
const cred = await q(`select profile, key from agent_channel_credentials where agent_id=$1 and channel_type='wechat'`, [AGENT_ID]);
console.log('CHANNEL agent_channel_credentials (wechat):', cred.length, JSON.stringify(cred));

// --- wechat sessions on Will (+ event totals) ---
const sess = await q(`select session_id, source_platform, message_count, user_ids, created_at from sessions where agent_id=$1 and (source_platform ilike '%wechat%' or source_platform ilike '%weixin%') order by created_at`, [AGENT_ID]);
let evTotal = 0;
for (const s of sess) { const n = (await q(`select count(*)::int n from session_events where agent_id=$1 and session_id=$2`,[AGENT_ID,s.session_id]))[0].n; s.events=n; evTotal+=n; }
console.log(`\nWECHAT SESSIONS: ${sess.length}, total events: ${evTotal}`);
for (const s of sess) console.log('  ', JSON.stringify(s));

// --- wechat-linked users: union of (identity on wechat + in roster) and (participant of a wechat session) ---
const rosterWxUsers = await q(`select distinct ui.user_id from user_identities ui join user_agents ua on ua.user_id=ui.user_id and ua.agent_id=$1 where ui.channel='wechat'`, [AGENT_ID]);
const sessUsers = new Set();
for (const s of sess) for (const u of (s.user_ids||[])) sessUsers.add(u);
const users = new Set([...rosterWxUsers.map(r=>r.user_id), ...sessUsers]);
console.log(`\nWECHAT-LINKED USERS (union): ${users.size}`);

let delUsers=0, keepUsers=0, delIds=0;
for (const uid of users) {
  const ids = await q(`select channel, channel_user_id from user_identities where user_id=$1`, [uid]);
  const channels = ids.map(i=>i.channel);
  const wxIds = ids.filter(i=>i.channel==='wechat');
  const memberships = await q(`select agent_id, role from user_agents where user_id=$1`, [uid]);
  const scheds = (await q(`select count(*)::int n from schedules where created_by=$1`, [uid]))[0].n;
  const roleOnWill = memberships.find(m=>m.agent_id===AGENT_ID)?.role ?? null;
  // pure wechat artifact: only wechat identity(ies), only membership is on Will, no schedules
  const pure = channels.every(ch=>ch==='wechat') && memberships.every(m=>m.agent_id===AGENT_ID) && scheds===0;
  delIds += wxIds.length;
  if (pure) delUsers++; else keepUsers++;
  console.log(`  ${uid} role=${roleOnWill} channels=[${[...new Set(channels)].join(',')}] memberships=${memberships.length} scheds=${scheds} wxIds=${wxIds.length} => ${pure?'DELETE-USER':'KEEP-USER(strip wechat)'}`);
}
console.log(`\nSUMMARY: delete-users=${delUsers}, keep-users(strip wechat)=${keepUsers}, wechat identities to remove=${delIds}, sessions=${sess.length}, events=${evTotal}`);

await c.end();
console.log('\n--- done (no writes) ---');
