-- Drop unused description columns from session_attachments and tighten
-- materialization_state with a CHECK constraint.
--
-- Background: the original 0026 migration included a `description` /
-- `description_state` pair intended for a server-side content preview
-- the model would see in `attachment_list`. We landed multimodal
-- inlining + sandbox materialization instead and never wrote the
-- description extractor, so the columns only added free-text noise
-- to every row.
--
-- The CHECK constraint guards against rogue writers; the app-side enum
-- already restricts callers, but defence-in-depth is cheap here.

ALTER TABLE "session_attachments" DROP COLUMN IF EXISTS "description";
ALTER TABLE "session_attachments" DROP COLUMN IF EXISTS "description_state";

ALTER TABLE "session_attachments"
  ADD CONSTRAINT "session_attachments_materialization_state_check"
  CHECK ("materialization_state" IN ('pending', 'copied', 'skipped', 'failed'));
