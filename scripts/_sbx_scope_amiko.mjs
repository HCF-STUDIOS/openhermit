// READ-ONLY amiko: hermit twins created since Oct 11 that received >=1 USER message.
// Emits JSON lines: hermit_agent_id, name, created, msgs, firstMsg, lastMsg — to correlate with openhermit.
import pg from 'pg';
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const q = async (s,p)=>(await c.query(s,p)).rows;
const iso=(ms)=>ms==null?null:new Date(Number(ms)).toISOString();

const rows = await q(`
  with t as (
    select id, name, hermit_agent_id, extract(epoch from created_at)*1000 c
    from amiko2.twins
    where agent_runtime='hermit' and hermit_agent_id is not null
      and created_at > '2026-10-11' and deleted_at is null
  )
  select t.id, t.name, t.hermit_agent_id, t.c,
    count(m.id) filter (where m.sender_type='user') umsgs,
    extract(epoch from min(m.created_at) filter (where m.sender_type='user'))*1000 fmin,
    extract(epoch from max(m.created_at) filter (where m.sender_type='user'))*1000 fmax
  from t
  join amiko2.conversation_participants cp on cp.participant_id = t.id and cp.participant_type='agent'
  join amiko2.messages m on m.conversation_id = cp.conversation_id
  group by t.id, t.name, t.hermit_agent_id, t.c
  having count(m.id) filter (where m.sender_type='user') > 0
  order by t.c`);

console.log(`candidates (new hermit twins with >=1 user msg): ${rows.length}`);
const out = rows.map(r=>({id:r.hermit_agent_id, name:r.name, created:iso(r.c), umsgs:Number(r.umsgs), first:iso(r.fmin), last:iso(r.fmax)}));
console.log('JSON_START');
console.log(JSON.stringify(out));
console.log('JSON_END');
await c.end();
