// READ-ONLY amiko DB: unambiguous epoch-ms timeline.
import pg from 'pg';
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const q = async (sql, p) => (await c.query(sql, p)).rows;
const HERMIT = 'cmv65sb2g000007jqrr2w3571';
const iso = (ms) => new Date(Number(ms)).toISOString();

const t = (await q(`select extract(epoch from created_at)*1000 c, extract(epoch from shipped_at)*1000 s from amiko2.twins where id=$1`,[HERMIT]))[0];
console.log('TWIN created :', iso(t.c), 'UTC');
console.log('TWIN shipped :', t.s? iso(t.s):'(null)', 'UTC');
console.log('OH agent row : 2026-10-13T04:08:35.994Z UTC  (openhermit agents.created_at)');

console.log('\nMESSAGES (UTC):');
const conv = (await q(`select conversation_id from amiko2.conversation_participants where participant_id=$1 limit 1`,[HERMIT]))[0];
for (const m of await q(`select extract(epoch from created_at)*1000 e, sender_type, left(coalesce(content,''),30) content from amiko2.messages where conversation_id=$1 order by created_at`,[conv.conversation_id]))
  console.log(`  ${iso(m.e)}  ${m.sender_type}  ${(m.content||'').replace(/\n/g,' ')}`);
console.log('\nnow:', new Date().toISOString());
await c.end();
