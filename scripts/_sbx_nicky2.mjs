// READ-ONLY: Nicky ownership + event count + sessions + sandbox.
import pg from 'pg';
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const q = async (sql, p) => (await c.query(sql, p)).rows;
const AG = 'cmv65sb2g000007jqrr2w3571';

console.log('=== total session_events for Nicky ===');
console.log(JSON.stringify((await q(`select count(*)::int n, min(ts) first, max(ts) last from openhermit.session_events where agent_id=$1`,[AG]))[0]));

console.log('\n=== user_agents (ownership) rows ===');
const ua = await q(`select * from openhermit.user_agents where agent_id=$1`,[AG]);
if (!ua.length) console.log('  !!! NO user_agents rows — agent is OWNERLESS');
for (const r of ua) console.log('  '+JSON.stringify(r));

console.log('\n=== sessions for Nicky ===');
const ss = await q(`select * from openhermit.sessions where agent_id=$1 order by 1 desc limit 10`,[AG]);
if (!ss.length) console.log('  (no sessions)');
for (const s of ss) console.log('  '+JSON.stringify(s));

console.log('\n=== sandboxes for Nicky ===');
try { for (const s of await q(`select * from openhermit.sandboxes where agent_id=$1`,[AG])) console.log('  '+JSON.stringify(s)); }
catch(e){ console.log('  sandboxes query failed:', e.message); }

console.log('\n=== schedules for Nicky ===');
try { for (const s of await q(`select id, kind, cron, enabled, created_by, next_run_at from openhermit.schedules where agent_id=$1`,[AG])) console.log('  '+JSON.stringify(s)); }
catch(e){ console.log('  schedules query failed:', e.message); }

// Compare: a known-working agent's user_agents shape (sally)
console.log('\n=== sally user_agents (reference for shape) ===');
for (const r of await q(`select * from openhermit.user_agents where agent_id='cmmkilrrg0006js04zomqi1r3'`)) console.log('  '+JSON.stringify(r));
await c.end();
