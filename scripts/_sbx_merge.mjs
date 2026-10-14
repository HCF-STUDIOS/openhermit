// Merge FROM William (telegram/lark) INTO William (cli/web/signal).
// DRY-RUN by default. CONFIRM=yes to apply. LIVE writes a JSON backup first.
//
// Covers ALL 8 user-id reference tables (the built-in userStore.merge() misses
// schedules.created_by, agent_channels.created_by, session_attachments,
// research_runs, and sessions.user_ids — this does not).
import pg from 'pg';
import { writeFileSync } from 'node:fs';

const FROM = 'usr-eee1347ed179'; // telegram:656756615 / lark / amiko x2
const INTO = 'usr-e334d575b366'; // cli:root / web / signal / amiko x2
const LIVE = process.env.CONFIRM === 'yes';
const RANK = { owner: 3, user: 2, guest: 1 };

const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const q = async (sql, p) => (await c.query(sql, p)).rows;
const n = async (sql, p) => (await q(sql, p))[0].n;

// sanity: both must exist, both named William
const both = await q(`select user_id, name, merged_into from users where user_id = any($1)`, [[FROM, INTO]]);
console.log('USERS:', JSON.stringify(both));
if (both.length !== 2) { console.log('ABORT: expected both users to exist'); await c.end(); process.exit(1); }

// scalar-column reference counts
const refs = [
  ['user_identities', `select count(*)::int n from user_identities where user_id=$1`],
  ['session_events',  `select count(*)::int n from session_events where user_id=$1`],
  ['schedules.created_by', `select count(*)::int n from schedules where created_by=$1`],
  ['agent_channels.created_by', `select count(*)::int n from agent_channels where created_by=$1`],
  ['session_attachments.uploader_user_id', `select count(*)::int n from session_attachments where uploader_user_id=$1`],
  ['research_runs.requested_by_user_id', `select count(*)::int n from research_runs where requested_by_user_id=$1`],
];
console.log('\nFROM reference counts:');
for (const [label, sql] of refs) console.log(`  ${label}: ${await n(sql, [FROM])}`);

// identities moving
const movingIds = await q(`select channel, channel_user_id from user_identities where user_id=$1 order by channel`, [FROM]);
console.log(`\nIdentities moving FROM->INTO (${movingIds.length}):`, JSON.stringify(movingIds));

// user_agents role-merge plan
const fromUA = await q(`select agent_id, role from user_agents where user_id=$1`, [FROM]);
const intoUA = new Map((await q(`select agent_id, role from user_agents where user_id=$1`, [INTO])).map(r=>[r.agent_id, r.role]));
let reassign=0, upgrade=0, dropSame=0;
const notable = [];
for (const m of fromUA) {
  const ex = intoUA.get(m.agent_id);
  if (!ex) { reassign++; if ((RANK[m.role]??0)>=3) notable.push(`reassign owner ${m.agent_id}`); }
  else if ((RANK[m.role]??0) > (RANK[ex]??0)) { upgrade++; notable.push(`upgrade ${m.agent_id} ${ex}->${m.role}`); }
  else dropSame++;
}
console.log(`\nuser_agents: FROM has ${fromUA.length} memberships -> reassign=${reassign}, upgrade=${upgrade}, drop(dupe/weaker)=${dropSame}`);
console.log('  notable (owner/upgrades):', JSON.stringify(notable));

// sessions.user_ids jsonb containing FROM
const sessRows = await q(`select agent_id, session_id, user_ids from sessions where user_ids @> $1::jsonb`, [JSON.stringify([FROM])]);
console.log(`\nsessions.user_ids containing FROM: ${sessRows.length}`);

if (!LIVE) {
  console.log('\nDRY-RUN — no changes. Re-run with CONFIRM=yes to apply (writes a backup first).');
  await c.end();
  process.exit(0);
}

// ---- LIVE: snapshot backup then one transaction ----
const backup = {
  ts_note: 'merge FROM into INTO', FROM, INTO,
  users: both,
  user_identities: await q(`select * from user_identities where user_id=$1`, [FROM]),
  user_agents_from: fromUA,
  user_agents_into: [...intoUA.entries()].map(([agent_id, role])=>({agent_id, role})),
  schedules: await q(`select id, agent_id, created_by from schedules where created_by=$1`, [FROM]).catch(()=>[]),
  agent_channels: await q(`select id, agent_id, created_by from agent_channels where created_by=$1`, [FROM]).catch(()=>[]),
  session_attachments: await q(`select id from session_attachments where uploader_user_id=$1`, [FROM]).catch(()=>[]),
  research_runs: await q(`select id from research_runs where requested_by_user_id=$1`, [FROM]).catch(()=>[]),
  sessions_user_ids: sessRows,
};
const backupPath = `/Users/william/Work/ai/openhermit/scripts/_merge_backup_${FROM}.json`;
writeFileSync(backupPath, JSON.stringify(backup, null, 2));
console.log(`\n[LIVE] backup written: ${backupPath}`);

await c.query('begin');
try {
  await c.query(`update user_identities set user_id=$2 where user_id=$1`, [FROM, INTO]);
  await c.query(`update session_events set user_id=$2 where user_id=$1`, [FROM, INTO]);
  await c.query(`update schedules set created_by=$2 where created_by=$1`, [FROM, INTO]);
  await c.query(`update agent_channels set created_by=$2 where created_by=$1`, [FROM, INTO]);
  await c.query(`update session_attachments set uploader_user_id=$2 where uploader_user_id=$1`, [FROM, INTO]);
  await c.query(`update research_runs set requested_by_user_id=$2 where requested_by_user_id=$1`, [FROM, INTO]);

  // user_agents: role-rank merge
  for (const m of fromUA) {
    const ex = intoUA.get(m.agent_id);
    if (!ex) {
      await c.query(`update user_agents set user_id=$2 where user_id=$1 and agent_id=$3`, [FROM, INTO, m.agent_id]);
    } else {
      if ((RANK[m.role]??0) > (RANK[ex]??0))
        await c.query(`update user_agents set role=$3 where user_id=$1 and agent_id=$2`, [INTO, m.agent_id, m.role]);
      await c.query(`delete from user_agents where user_id=$1 and agent_id=$2`, [FROM, m.agent_id]);
    }
  }

  // sessions.user_ids jsonb: replace FROM with INTO, dedup
  for (const s of sessRows) {
    const next = [...new Set((s.user_ids||[]).map(x => x === FROM ? INTO : x))];
    await c.query(`update sessions set user_ids=$3::jsonb where agent_id=$1 and session_id=$2`, [s.agent_id, s.session_id, JSON.stringify(next)]);
  }

  // delete the FROM user row (identities already moved; resolve() stays consistent)
  await c.query(`delete from users where user_id=$1`, [FROM]);

  await c.query('commit');
  console.log('[LIVE] merge committed.');
} catch (e) {
  await c.query('rollback');
  console.log('ROLLED BACK:', e.message);
  process.exitCode = 1;
}

// verify
const after = await q(`select user_id, name from users where user_id = any($1)`, [[FROM, INTO]]);
const ownersWill = await q(`select user_id, role from user_agents where agent_id='cmewkyjkh0002ld04ydjqh3pq' and role='owner'`);
const intoIds = await q(`select channel, channel_user_id from user_identities where user_id=$1 order by channel`, [INTO]);
console.log('\nAFTER:');
console.log('  users remaining:', JSON.stringify(after));
console.log('  Will owners:', JSON.stringify(ownersWill));
console.log('  INTO identities:', JSON.stringify(intoIds));

await c.end();
console.log('\n--- done ---');
