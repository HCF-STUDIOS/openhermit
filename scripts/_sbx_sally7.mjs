// READ-ONLY: separate "live incident" from "dormant churn", + healthy template row + sally specifics.
import pg from 'pg';
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const q = async (sql, p) => (await c.query(sql, p)).rows;
const SALLY_AG = 'cmnwioug2000004jrb45jzzo0';
const SALLY_USER = 'usr-5023b9ec706f';

// Classify the zero-schedule feed-scan agents by status + session recency.
const rows = await q(`
  with feed_sess as (
    select agent_id, max(last_activity_at) last_act
    from sessions where session_id like 'schedule:feed-scan%' group by agent_id
  ),
  dead as (
    select f.agent_id, f.last_act, a.status
    from feed_sess f left join agents a on a.agent_id=f.agent_id
    where (select count(*) from schedules s where s.agent_id=f.agent_id)=0
  )
  select
    count(*) filter (where status='active') active_total,
    count(*) filter (where status='active' and last_act > '2026-09-01') active_recent_sep,
    count(*) filter (where status='active' and last_act > '2026-10-01') active_recent_oct,
    count(*) filter (where status='active' and last_act <= '2026-09-01') active_stale,
    count(*) filter (where status <> 'active') nonactive,
    count(*) total
  from dead`);
console.log('zero-schedule feed-scan agents, classified:');
console.log(JSON.stringify(rows[0], null, 2));

// For comparison: feed-scan agents that DO still have a schedule — how many, active?
const alive = await q(`
  with feed_sess as (select distinct agent_id from sessions where session_id like 'schedule:feed-scan%')
  select count(*) total,
         count(*) filter (where a.status='active') active
  from feed_sess f
  join agents a on a.agent_id=f.agent_id
  where exists (select 1 from schedules s where s.agent_id=f.agent_id and s.schedule_id like 'feed-scan%')`);
console.log('\nfeed-scan agents that STILL have a feed-scan schedule row:', JSON.stringify(alive[0]));

// Healthy template: a currently-firing feed-scan-default schedule, all columns.
const tmpl = await q(`select * from schedules where schedule_id='feed-scan-comment-default' and consecutive_errors=0 and next_run_at is not null order by last_run_at desc limit 1`);
console.log('\n=== healthy template feed-scan-comment-default row ===');
console.log(JSON.stringify(tmpl[0], null, 2));

// Sally owner reachability: does owner still exist/unmerged, and any wallet/credit signal?
console.log('\n=== sally owner ===');
console.log(JSON.stringify(await q(`select user_id, name, merged_into, created_at from users where user_id=$1`, [SALLY_USER])));
console.log('sally agent status/enabled:', JSON.stringify(await q(`select agent_id, name, status from agents where agent_id=$1`, [SALLY_AG])));
console.log('sally agent_channels:', JSON.stringify(await q(`select channel_type, enabled, consecutive_failure_count, last_error from agent_channels where agent_id=$1`, [SALLY_AG])));

await c.end();
