-- Fleet dashboard fleetStats() at scale (issue #208). The errors24h metric
-- filters session_events by (agent_id IN (...), event_type = 'error', ts > since);
-- no existing index matches that predicate, so it scans per agent. This index
-- serves it directly.
--
-- IF NOT EXISTS makes it idempotent: on a very large session_events table an
-- operator may prefer to build it manually with CREATE INDEX CONCURRENTLY
-- (which cannot run inside a migration transaction) before deploying — this
-- statement then becomes a no-op.
CREATE INDEX IF NOT EXISTS "idx_session_events_agent_type_ts" ON "session_events" USING btree ("agent_id","event_type","ts");
