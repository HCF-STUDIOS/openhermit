-- An agent must have at most one owner. The table PK is (user_id, agent_id),
-- which only makes each (user, agent) pair unique — it never stopped two
-- DIFFERENT users each holding role='owner' on the same agent. Several agents
-- accumulated 2-3 owners this way (shadow owners bound via channel/import paths
-- that called the blind assignOwner/assignAgent upserts). This partial unique
-- index is the database-level backstop for the single-owner invariant.
--
-- Pre-existing duplicate owners MUST be resolved before this runs, or index
-- creation fails. The 2026-11-10 cleanup demoted surplus owners to role='user'
-- (backup: openhermit._incident_owner_dedupe20261110).
--
-- IF NOT EXISTS keeps it idempotent against the hand-applied hotfix index.
CREATE UNIQUE INDEX IF NOT EXISTS "user_agents_one_owner"
  ON "user_agents" ("agent_id")
  WHERE "role" = 'owner';
