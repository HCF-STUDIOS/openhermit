// Reset Will's OWNER wechat binding for a manual first-contact test.
// DRY-RUN by default. Set CONFIRM=yes to actually write.
//
// Targets (owner usr-e334d575b366 only; the 19 user-role wechat identities are left intact):
//   1. agent_channels: disable wechat (enabled=false)
//   2. session_events of session wechat:2026-10-05-65ca6c42
//   3. sessions row wechat:2026-10-05-65ca6c42
//   4. user_identities: the owner's single wechat identity
import pg from 'pg';

const AGENT_ID = 'cmewkyjkh0002ld04ydjqh3pq';
const SESSION_ID = 'wechat:2026-10-05-65ca6c42';
const OWNER_USER = 'usr-e334d575b366';
const WECHAT_CUID = 'o9cq804c8lCFs2mlC7igP2j6VkQ4@im.wechat';
const LIVE = process.env.CONFIRM === 'yes';

const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();

const count = async (sql, p) => (await c.query(sql, p)).rows[0].n;

const nChan = await count(
  `select count(*)::int n from agent_channels where agent_id=$1 and channel_type='wechat' and enabled=true`,
  [AGENT_ID],
);
const nEvents = await count(
  `select count(*)::int n from session_events where agent_id=$1 and session_id=$2`,
  [AGENT_ID, SESSION_ID],
);
const nSess = await count(
  `select count(*)::int n from sessions where agent_id=$1 and session_id=$2`,
  [AGENT_ID, SESSION_ID],
);
const nId = await count(
  `select count(*)::int n from user_identities where channel='wechat' and channel_user_id=$1 and user_id=$2`,
  [WECHAT_CUID, OWNER_USER],
);

console.log(`[${LIVE ? 'LIVE' : 'DRY-RUN'}] targets:`);
console.log(`  wechat channel rows to disable (currently enabled): ${nChan}`);
console.log(`  session_events to delete: ${nEvents}`);
console.log(`  sessions to delete: ${nSess}`);
console.log(`  owner wechat identities to delete: ${nId}`);

if (!LIVE) {
  console.log('\nDRY-RUN — no changes written. Re-run with CONFIRM=yes to apply.');
  await c.end();
  process.exit(0);
}

await c.query('begin');
try {
  const d1 = await c.query(
    `update agent_channels set enabled=false where agent_id=$1 and channel_type='wechat'`,
    [AGENT_ID],
  );
  const d2 = await c.query(
    `delete from session_events where agent_id=$1 and session_id=$2`,
    [AGENT_ID, SESSION_ID],
  );
  const d3 = await c.query(
    `delete from sessions where agent_id=$1 and session_id=$2`,
    [AGENT_ID, SESSION_ID],
  );
  const d4 = await c.query(
    `delete from user_identities where channel='wechat' and channel_user_id=$1 and user_id=$2`,
    [WECHAT_CUID, OWNER_USER],
  );
  await c.query('commit');
  console.log('\n[LIVE] applied:');
  console.log(`  agent_channels disabled (rows matched): ${d1.rowCount}`);
  console.log(`  session_events deleted: ${d2.rowCount}`);
  console.log(`  sessions deleted: ${d3.rowCount}`);
  console.log(`  owner wechat identity deleted: ${d4.rowCount}`);
} catch (e) {
  await c.query('rollback');
  console.log('ROLLED BACK:', e.message);
  process.exitCode = 1;
}
await c.end();
