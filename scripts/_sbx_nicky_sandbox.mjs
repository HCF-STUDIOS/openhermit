// READ-ONLY openhermit: compare Nicky sandbox vs active agents; confirm no DM session.
import pg from 'pg';
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const q = async (sql, p) => (await c.query(sql, p)).rows;
const NICKY = 'cmv65sb2g000007jqrr2w3571';

console.log('=== Nicky sandbox ===');
for (const s of await q(`select alias, type, status, external_id, last_seen_at, created_at from openhermit.sandboxes where agent_id=$1`,[NICKY])) console.log(' ', JSON.stringify(s));

console.log('\n=== sally sandbox (active ref) ===');
for (const s of await q(`select alias, type, status, external_id is not null has_ext, last_seen_at, created_at from openhermit.sandboxes where agent_id='cmmkilrrg0006js04zomqi1r3'`)) console.log(' ', JSON.stringify(s));

console.log('\n=== sandbox status distribution (all agents) ===');
for (const r of await q(`select status, count(*)::int n, count(external_id)::int with_ext from openhermit.sandboxes group by status order by n desc`)) console.log(' ', JSON.stringify(r));

console.log('\n=== recently-created agents: do they have events? (cohort around Nicky) ===');
for (const r of await q(`
  select a.agent_id, a.name, a.created_at,
    (select count(*) from openhermit.session_events e where e.agent_id=a.agent_id)::int events,
    (select status from openhermit.sandboxes s where s.agent_id=a.agent_id limit 1) sb_status,
    (select external_id is not null from openhermit.sandboxes s where s.agent_id=a.agent_id limit 1) sb_ext
  from openhermit.agents a
  where a.created_at > '2026-10-11' order by a.created_at desc limit 25`))
  console.log(`  ${r.created_at} ${r.agent_id.slice(-6)} ${String(r.name).slice(0,16).padEnd(16)} events=${String(r.events).padStart(4)} sb=${r.sb_status}/${r.sb_ext?'ext':'noext'}`);

console.log('\n=== any sessions for Nicky besides inbox? ===');
for (const s of await q(`select session_id, type, status, message_count, created_at from openhermit.sessions where agent_id=$1`,[NICKY])) console.log(' ', JSON.stringify(s));
await c.end();
