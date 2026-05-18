-- Per-session uploaded files. Byte payload lives in an AttachmentStorage
-- provider (local disk / s3 / supabase); this row is the metadata of
-- record. See docs/file-attachments-design.md.

CREATE TABLE "session_attachments" (
  "id"                     TEXT PRIMARY KEY,
  "agent_id"               TEXT NOT NULL,
  "session_id"             TEXT NOT NULL,
  "uploader_user_id"       TEXT,
  "original_name"          TEXT NOT NULL,
  "safe_name"              TEXT NOT NULL,
  "mime_type"              TEXT NOT NULL,
  "size_bytes"             INTEGER NOT NULL,
  "sha256"                 TEXT NOT NULL,
  "storage_provider"       TEXT NOT NULL,
  "storage_key"            TEXT NOT NULL,
  "sandbox_id"             TEXT,
  "sandbox_path"           TEXT,
  "materialization_state"  TEXT NOT NULL DEFAULT 'pending',
  "materialization_error"  TEXT,
  "description"            TEXT,
  "description_state"      TEXT NOT NULL DEFAULT 'pending',
  "created_at"             TEXT NOT NULL
);

CREATE INDEX "idx_session_attachments_session"
  ON "session_attachments" ("agent_id", "session_id", "created_at");

-- Powers `attachment_list` with `scope: 'user'` — every file a given
-- user uploaded under this agent, newest first.
CREATE INDEX "idx_session_attachments_user"
  ON "session_attachments" ("agent_id", "uploader_user_id", "created_at");

CREATE INDEX "idx_session_attachments_sha256"
  ON "session_attachments" ("sha256");
