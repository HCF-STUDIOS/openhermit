// READ-ONLY amiko DB: precise UTC timeline — twin creation vs messages.
import pg from 'pg';
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const q = async (sql, p) => (await c.query(sql, p)).rows;
const HERMIT = 'cmv65sb2g000007jqrr2w3571';

const t = (await q(`select id, name, created_at at time zone 'UTC' created_utc, is_shipped, shipped_at at time zone 'UTC' shipped_utc, service_agent_configured, bootstrap_done from amiko2.twins where id=$1`,[HERMIT]))[0];
console.log('TWIN (amiko) created_utc:', t.created_utc, '| shipped_utc:', t.shipped_utc, '| configured:', t.service_agent_configured, '| bootstrap:', t.bootstrap_done);

console.log('\nALL messages in conv (UTC), sender side:');
const conv = (await q(`select conversation_id from amiko2.conversation_participants where participant_id=$1 limit 1`,[HERMIT]))[0];
for (const m of await q(`select created_at at time zone 'UTC' u, sender_type, right(sender_id,6) s, left(coalesce(content,''),40) content from amiko2.messages where conversation_id=$1 order by created_at`,[conv.conversation_id]))
  console.log(`  ${m.u}  ${m.sender_type}:${m.s}  ${(m.content||'').replace(/\n/g,' ')}`);

console.log('\n(openhermit agent row was created 2026-10-13T04:08:35.994Z UTC — compare above)');
console.log('now UTC:', (await q(`select now() at time zone 'UTC' n`))[0].n);
await c.end();
