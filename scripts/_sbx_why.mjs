// READ-ONLY: answer "why so many wechat users on Will?" No writes.
import pg from 'pg';
const AGENT_ID = 'cmewkyjkh0002ld04ydjqh3pq';
const OWNER = 'usr-e334d575b366';
const WILLWX = 'o9cq804c8lCFs2mlC7igP2j6VkQ4@im.wechat'; // William's own wechat account
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const q = async (sql, p) => (await c.query(sql, p)).rows;

// 1. roster by role — how many owners does Will really have?
const byRole = await q(`select role, count(*)::int n from user_agents where agent_id=$1 group by role order by role`, [AGENT_ID]);
console.log('WILL ROSTER by role:', JSON.stringify(byRole));

// 2. the owner's identities
const ownerIds = await q(`select channel, channel_user_id from user_identities where user_id=$1 order by channel`, [OWNER]);
console.log(`OWNER ${OWNER} identities:`, JSON.stringify(ownerIds));

// 3. every wechat identity that is ALSO a roster member of Will — with how they joined Will
const rows = await q(`
  select ui.user_id, ui.channel_user_id as wx_account, ui.created_at as wx_created,
         ua.role as role_on_will, ua.created_at as joined_will,
         (select array_agg(distinct x.channel) from user_identities x where x.user_id=ui.user_id) as all_channels
  from user_identities ui
  join user_agents ua on ua.user_id=ui.user_id and ua.agent_id=$1
  where ui.channel='wechat'
  order by ua.created_at`, [AGENT_ID]);
console.log(`\nWECHAT-id users on Will's roster: ${rows.length}`);
for (const r of rows) {
  const isWill = r.wx_account === WILLWX;
  console.log(`  ${r.user_id} role=${r.role_on_will} joinedWill=${r.joined_will?.toISOString?.()||r.joined_will} wxAcct=${r.wx_account}${isWill?' <== WILLIAM-OWN':''} wxCreated=${r.wx_created?.toISOString?.()||r.wx_created} channels=[${(r.all_channels||[]).join(',')}]`);
}

// 4. are those wechat accounts distinct real accounts, and do any === William's?
const distinctWx = new Set(rows.map(r=>r.wx_account));
console.log(`\nDistinct wechat accounts among them: ${distinctWx.size}; any === William's (${WILLWX})? ${[...distinctWx].includes(WILLWX)}`);

await c.end();
console.log('\n--- done (no writes) ---');
