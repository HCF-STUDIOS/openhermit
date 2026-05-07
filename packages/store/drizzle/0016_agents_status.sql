-- Per-agent status flag. The gateway treats this column as the source
-- of truth for whether an agent accepts incoming requests; the
-- in-memory runner Map is only a hydration cache.
--
-- Values:
--   'active'   — accept requests; hydrate runner on demand
--   'disabled' — reject requests; existing runner (if any) is stopped
ALTER TABLE "agents"
  ADD COLUMN IF NOT EXISTS "status" text NOT NULL DEFAULT 'active';

CREATE INDEX IF NOT EXISTS "idx_agents_status" ON "agents" ("status");
