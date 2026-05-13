-- Expression index on session_events to speed up the messageId-based
-- idempotency lookup used by appendMessage. Partial: only entries that
-- carry a messageId (i.e. user/assistant turns from external callers).
CREATE INDEX IF NOT EXISTS "idx_session_events_agent_session_message_id"
  ON "session_events" ("agent_id", "session_id", ((payload->>'messageId')))
  WHERE payload ? 'messageId';
