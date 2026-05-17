-- Persist the last channel-runtime error so it survives gateway restarts
-- and is visible to the user in the channels list when a bridge fails to
-- start (e.g. invalid bot token, revoked OAuth grant, webhook URL needed
-- but not configured).
ALTER TABLE "agent_channels"
  ADD COLUMN IF NOT EXISTS "last_error" TEXT,
  ADD COLUMN IF NOT EXISTS "last_error_at" TEXT;
