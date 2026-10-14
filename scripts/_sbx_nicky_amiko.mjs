// READ-ONLY against amiko DB (amiko2 schema). Why is Nicky not replying?
import pg from 'pg';
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const q = async (sql, p) => (await c.query(sql, p)).rows;
const HERMIT = 'cmv65sb2g000007jqrr2w3571';

console.log('=== twin (by hermit_agent_id) ===');
const twins = await q(`select id, name, user_id, type, agent_runtime, hermit_agent_id, service_agent_configured, bootstrap_done,
  paused_for_credits, credit_paused_at, is_shipped, is_public, created_at, deleted_at
  from amiko2.twins where hermit_agent_id=$1 or id=$1`,[HERMIT]);
for (const t of twins) console.log(JSON.stringify(t,null,1));
if (!twins.length){ console.log('  !!! no twin row'); await c.end(); process.exit(0);}
const twin = twins[0];

console.log('\n=== owner (user) ===');
for (const u of await q(`select id, email, default_agent_enabled, credits_cached_balance, ludi_balance from amiko2.users where id=$1`,[twin.user_id]))
  console.log(JSON.stringify(u));

console.log('\n=== twin wallets ===');
for (const w of await q(`select id, chain, chain_type, status, balance, last_synced_at from amiko2.twin_wallets where twin_id=$1`,[twin.id]))
  console.log(JSON.stringify(w));

console.log('\n=== conversations involving this twin (as participant) ===');
const parts = await q(`select conversation_id, participant_type, participant_id, agent_enabled, role from amiko2.conversation_participants where participant_id=$1 order by 1 desc limit 20`,[twin.id]).catch(e=>{console.log('part err',e.message);return[];});
for (const p of parts) console.log(JSON.stringify(p));

console.log('\n=== recent messages in those conversations (last 15) ===');
const convIds = [...new Set(parts.map(p=>p.conversation_id))];
if (convIds.length){
  const msgs = await q(`select id, conversation_id, sender_type, sender_id, left(coalesce(content,''),60) content, created_at
    from amiko2.messages where conversation_id = any($1) order by created_at desc limit 15`,[convIds]).catch(e=>{console.log('msg err',e.message);return[];});
  for (const m of msgs) console.log(`  ${m.created_at} conv=${m.conversation_id.slice(-6)} ${m.sender_type}:${(m.sender_id||'').slice(-6)} ${(m.content||'').replace(/\n/g,' ')}`);
} else console.log('  (no conversations found)');

console.log('\n  now:', (await q(`select now() n`))[0].n);
await c.end();
