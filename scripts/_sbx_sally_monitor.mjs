// READ-ONLY live monitor for sally. Polls every 3 min for ~48 min. Exits early
// (so the agent is re-invoked) the moment a NEW error event appears after start.
import pg from 'pg';
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const q = async (sql, p) => (await c.query(sql, p)).rows;
const AG = 'cmmkilrrg0006js04zomqi1r3';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const START = (await q(`select now() n`))[0].n.toISOString();
console.log(`[monitor] start ${START} — watching sally for new errors / delivery gaps`);

const INTERVAL_MS = 3 * 60 * 1000;
const MAX_POLLS = 16;
let lastSeen = START;

for (let i = 1; i <= MAX_POLLS; i++) {
  await sleep(INTERVAL_MS);
  const now = (await q(`select now() n`))[0].n.toISOString();

  // New error events since start?
  const errs = await q(
    `select session_id, ts, left(coalesce(content,''),160) content
       from session_events where agent_id=$1 and event_type='error' and ts > $2
       order by ts desc limit 10`, [AG, START]);

  // Activity since last poll (ok vs error assistant turns) + any error stopReason.
  const act = (await q(
    `select count(*) filter (where (payload->>'stopReason') is distinct from 'error' and payload ? 'usage')::int ok,
            count(*) filter (where payload->>'stopReason'='error')::int err
       from session_events where agent_id=$1 and event_type='assistant' and ts > $2`,
    [AG, lastSeen]))[0];
  const lastEvt = (await q(
    `select ts, event_type from session_events where agent_id=$1 order by ts desc limit 1`, [AG]))[0];
  lastSeen = now;

  console.log(`[poll ${i}/${MAX_POLLS}] ${now} | since-last ok=${act.ok} err=${act.err} | lastEvent=${lastEvt.ts} ${lastEvt.event_type} | totalNewErrors=${errs.length}`);

  if (errs.length > 0) {
    console.log('\n*** NEW ERROR(S) DETECTED ***');
    for (const e of errs) console.log(`  ${e.ts} (${e.session_id}) ${(e.content||'').replace(/\n/g,' ')}`);
    await c.end();
    process.exit(0);
  }
}
console.log(`[monitor] done — no new errors across ${MAX_POLLS} polls (~48 min). sally stable.`);
await c.end();
