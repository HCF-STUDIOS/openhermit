// READ-ONLY: current wechat state on Will right now. No writes.
import pg from 'pg';
const AGENT = 'cmewkyjkh0002ld04ydjqh3pq';
const WX = 'o9cq804c8lCFs2mlC7igP2j6VkQ4@im.wechat';
const OWNER = 'usr-e334d575b366';
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const q = async (sql, p) => (await c.query(sql, p)).rows;

console.log('CHANNEL (bridge):', JSON.stringify(await q(`select id, enabled, channel_type, token_prefix is not null as has_token from agent_channels where agent_id=$1 and channel_type='wechat'`,[AGENT])));

const r = await q(`select ui.user_id, u.name, u.merged_into from user_identities ui left join users u on u.user_id=ui.user_id where ui.channel='wechat' and ui.channel_user_id=$1`,[WX]);
console.log(`\nYOUR wechat (${WX}) resolves to:`, r.length ? JSON.stringify(r) : 'NOBODY');

console.log('\nOWNER wechat identities:', JSON.stringify(await q(`select channel_user_id from user_identities where user_id=$1 and channel='wechat'`,[OWNER])));

const sess = await q(`select session_id, source_platform, message_count, user_ids, created_at from sessions where agent_id=$1 and (source_platform ilike '%wechat%' or source_platform ilike '%weixin%') order by created_at`,[AGENT]);
console.log(`\nWECHAT SESSIONS now (${sess.length}):`);
for (const s of sess) console.log('  ', JSON.stringify(s));

console.log('\nWill owners:', JSON.stringify(await q(`select user_id, role from user_agents where agent_id=$1 and role='owner'`,[AGENT])));
console.log('usr-mv5700w4 still exists?', (await q(`select 1 from users where user_id='usr-mv5700w4'`)).length ? 'YES' : 'no');

await c.end();
