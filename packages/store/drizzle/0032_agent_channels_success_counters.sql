-- Track channel-success state alongside the existing last_error columns so
-- the UI can distinguish "errored and never recovered" from "errored once,
-- working again". Counters survive last_error being cleared so postmortems
-- can still answer "how many failures preceded the recovery?".
ALTER TABLE "agent_channels"
  ADD COLUMN IF NOT EXISTS "last_success_at" TEXT,
  ADD COLUMN IF NOT EXISTS "consecutive_failure_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "total_failure_count" INTEGER NOT NULL DEFAULT 0;
