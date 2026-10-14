// READ-ONLY: locate Sally's agent and its state.
import pg from 'pg';
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const q = async (sql, p) => (await c.query(sql, p)).rows;

console.log('=== agents named like sally ===');
const agents = await q(`select agent_id, name, status, backend_state, created_at, updated_at from agents where name ilike '%sally%' order by updated_at desc nulls last`);
for (const a of agents) console.log(JSON.stringify(a));

console.log('\n=== users named like sally ===');
const users = await q(`select user_id, name, merged_into, created_at from users where name ilike '%sally%'`);
for (const u of users) console.log(JSON.stringify(u));

// identities that look like sally
console.log('\n=== identities channel_user_id like sally ===');
const ids = await q(`select user_id, channel, channel_user_id from user_identities where channel_user_id ilike '%sally%' limit 20`);
for (const i of ids) console.log(JSON.stringify(i));

await c.end();
