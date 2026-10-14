import pg from 'pg';
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const q = async (s,p)=>(await c.query(s,p)).rows;
const iso=(ms)=>new Date(Number(ms)).toISOString();
const TWIN='cmv65sb2g000007jqrr2w3571';
const conv='cmv65wlzq000007l7topa20qd';

console.log('participants (joined_at UTC):');
for (const p of await q(`select participant_type, right(participant_id,6) pid, agent_enabled, role, extract(epoch from joined_at)*1000 j, left_at, deleted_at from amiko2.conversation_participants where conversation_id=$1 order by joined_at`,[conv]))
  console.log(`  ${iso(p.j)}  ${p.participant_type}:${p.pid}  agent_enabled=${p.agent_enabled} role=${p.role} left=${p.left_at} del=${p.deleted_at}`);

console.log('\nshared_account_sessions for this twin (hermit session mapping):');
const sas = await q(`select persona, hermit_session_id, extract(epoch from created_at)*1000 c from amiko2.shared_account_sessions where twin_id=$1`,[TWIN]);
if(!sas.length) console.log('  (none — no hermit session was ever opened for this twin)');
for (const s of sas) console.log(`  ${iso(s.c)} persona=${s.persona} sess=${s.hermit_session_id}`);

console.log('\nFYI messages: 04:31:36 .. 05:11:35 UTC (5 user msgs); conv created 04:09:39 UTC');
await c.end();
