// READ-ONLY: identify usr-eee1347ed179. No writes.
import pg from 'pg';
const U = 'usr-eee1347ed179';
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const q = async (sql, p) => (await c.query(sql, p)).rows;

// discover agents table columns
const cols = await q(`select column_name from information_schema.columns where table_name='agents' order by ordinal_position`);
console.log('agents columns:', cols.map(r=>r.column_name).join(', '));

// identities
console.log('\nIDENTITIES:', JSON.stringify(await q(`select channel, channel_user_id, created_at from user_identities where user_id=$1 order by created_at`, [U])));

// the user row itself
const urow = await q(`select * from users where user_id=$1`, [U]).catch(()=>[]);
console.log('\nUSER ROW:', JSON.stringify(urow[0]||'(no users table match)'));

// agents it owns
const owned = await q(`select agent_id, role, created_at from user_agents where user_id=$1 and role='owner' order by created_at`, [U]);
console.log(`\nOWNS ${owned.length} agents:`);
for (const o of owned) {
  const a = await q(`select * from agents where agent_id=$1`, [o.agent_id]).catch(async()=> await q(`select * from agents where id=$1`, [o.agent_id]).catch(()=>[]));
  const row = a[0]||{};
  const pick = {};
  for (const k of Object.keys(row)) if (/name|handle|slug|display|title|created_at/i.test(k)) pick[k]=row[k];
  console.log(`  ${o.agent_id} (owner since ${o.created_at?.toISOString?.()||o.created_at}):`, JSON.stringify(pick));
}

// recent sessions by this user across agents
const sess = await q(`select agent_id, session_id, source_platform, message_count, last_activity_at from sessions where user_ids @> $1::jsonb order by last_activity_at desc nulls last limit 10`, [JSON.stringify([U])]);
console.log(`\nRECENT SESSIONS (${sess.length}):`);
for (const s of sess) console.log('  ', JSON.stringify(s));

await c.end();
console.log('\n--- done (no writes) ---');
