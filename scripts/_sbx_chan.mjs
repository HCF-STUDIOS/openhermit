// READ-ONLY: full wechat channel row + credentials for Will.
import pg from 'pg';
const AGENT = 'cmewkyjkh0002ld04ydjqh3pq';
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const q = async (sql, p) => (await c.query(sql, p)).rows;
console.log('agent_channels (wechat):', JSON.stringify(await q(
  `select id, agent_id, channel_type, namespace, enabled, created_by, token_prefix, (token_ciphertext is not null) as has_cipher, created_at, updated_at
     from agent_channels where agent_id=$1 and channel_type='wechat'`, [AGENT]), null, 2));
const cr = await q(`select agent_id, channel_type, profile, key, created_at from agent_channel_credentials where agent_id=$1 and channel_type='wechat'`, [AGENT]);
console.log('\nagent_channel_credentials (wechat):', cr.length, JSON.stringify(cr, null, 2));
// any other channels on this agent, for reference
console.log('\nall channels on agent:', JSON.stringify(await q(
  `select channel_type, namespace, enabled, token_prefix is not null as has_token from agent_channels where agent_id=$1 order by channel_type`, [AGENT])));
await c.end();
