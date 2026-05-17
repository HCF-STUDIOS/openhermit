-- Partial index on session_events to accelerate the usage aggregation
-- queries (fleetUsage / usageTotals / agentUsageDetail). Filters to only
-- the rows that the aggregator scans (assistant events carrying a usage
-- payload) and leads with (agent_id, ts) so per-agent time-windowed
-- SUMs can index-scan instead of seq-scanning session_events.
CREATE INDEX IF NOT EXISTS "idx_session_events_assistant_usage"
  ON "session_events" ("agent_id", "ts")
  WHERE event_type = 'assistant' AND payload ? 'usage';
