-- Per-agent canonical inbox session.
--
-- Each agent gets a single, eager-created `sessions` row with id 'inbox'.
-- The inbox is read-only owner feed for async approval requests and other
-- owner-attention notifications. Agent register hook keeps new agents
-- covered going forward; this migration backfills existing agents.

INSERT INTO sessions (
  agent_id,
  session_id,
  source_kind,
  source_platform,
  interactive,
  created_at,
  last_activity_at,
  message_count,
  completed_turn_count,
  metadata,
  status,
  type,
  user_ids
)
SELECT
  agent_id,
  'inbox',
  'inbox',
  'inbox',
  0,
  to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  0,
  0,
  '{}'::jsonb,
  'idle',
  'direct',
  '[]'::jsonb
FROM agents
ON CONFLICT (agent_id, session_id) DO NOTHING;
