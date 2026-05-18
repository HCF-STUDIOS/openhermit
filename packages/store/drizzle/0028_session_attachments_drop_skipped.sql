-- Backfill any rows that were marked 'skipped' under the old
-- sandbox-copy threshold. attachment_fetch now re-materializes
-- on demand, so 'pending' is the correct resting state for these.
UPDATE "session_attachments"
  SET "materialization_state" = 'pending'
  WHERE "materialization_state" = 'skipped';

-- Tighten the CHECK constraint to the new state set.
ALTER TABLE "session_attachments"
  DROP CONSTRAINT IF EXISTS "session_attachments_materialization_state_check";

ALTER TABLE "session_attachments"
  ADD CONSTRAINT "session_attachments_materialization_state_check"
  CHECK ("materialization_state" IN ('pending', 'copied', 'failed'));
