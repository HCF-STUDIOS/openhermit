-- Deep Research durable workflow state: runs, idempotent steps, normalized
-- source snapshots, and verified evidence excerpts. One nonterminal run per
-- session; every citation in a final report resolves through these rows.
-- See docs/deep-research-design.md §18. No FKs by repo convention — cascade
-- is explicit code in the research store's deleteBySession.

CREATE TABLE "research_runs" (
  "run_id"                 TEXT PRIMARY KEY,
  "agent_id"               TEXT NOT NULL,
  "session_id"             TEXT NOT NULL,
  "requested_by_user_id"   TEXT,
  "client_request_id"      TEXT,
  "status"                 TEXT NOT NULL DEFAULT 'created',
  "resume_phase"           TEXT,
  "terminal_reason"        TEXT,
  "depth"                  TEXT NOT NULL DEFAULT 'standard',
  "objective"              TEXT NOT NULL,
  "plan_json"              JSONB,
  "plan_version"           INTEGER NOT NULL DEFAULT 0,
  "source_policy_json"     JSONB NOT NULL DEFAULT '{}'::jsonb,
  "budget_json"            JSONB NOT NULL DEFAULT '{}'::jsonb,
  "usage_json"             JSONB NOT NULL DEFAULT '{}'::jsonb,
  "working_state_json"     JSONB NOT NULL DEFAULT '{}'::jsonb,
  "report_json"            JSONB,
  "pause_requested"        BOOLEAN NOT NULL DEFAULT false,
  "cancel_requested"       BOOLEAN NOT NULL DEFAULT false,
  "last_error"             TEXT,
  "created_at"             TEXT NOT NULL,
  "updated_at"             TEXT NOT NULL,
  "started_at"             TEXT,
  "completed_at"           TEXT
);

CREATE INDEX IF NOT EXISTS "idx_research_runs_session"
  ON "research_runs" ("agent_id", "session_id", "created_at");

CREATE INDEX IF NOT EXISTS "idx_research_runs_status"
  ON "research_runs" ("agent_id", "status", "updated_at");

-- Idempotent run creation per session.
CREATE UNIQUE INDEX IF NOT EXISTS "research_runs_client_request_unique"
  ON "research_runs" ("agent_id", "session_id", "client_request_id")
  WHERE client_request_id IS NOT NULL;

-- One nonterminal run per session.
CREATE UNIQUE INDEX IF NOT EXISTS "research_runs_one_active_per_session"
  ON "research_runs" ("agent_id", "session_id")
  WHERE status NOT IN ('completed', 'cancelled');

-- Durable, idempotent workflow steps — the execution cursor. A step row is
-- inserted 'pending' with a deterministic dedupe key before its action runs;
-- retries bump attempt on the same row.
CREATE TABLE "research_steps" (
  "step_id"       TEXT PRIMARY KEY,
  "run_id"        TEXT NOT NULL,
  "agent_id"      TEXT NOT NULL,
  "iteration"     INTEGER NOT NULL DEFAULT 0,
  "attempt"       INTEGER NOT NULL DEFAULT 1,
  "kind"          TEXT NOT NULL,
  "status"        TEXT NOT NULL DEFAULT 'pending',
  "dedupe_key"    TEXT NOT NULL,
  "question_ids"  JSONB NOT NULL DEFAULT '[]'::jsonb,
  "input_json"    JSONB NOT NULL DEFAULT '{}'::jsonb,
  "output_json"   JSONB NOT NULL DEFAULT '{}'::jsonb,
  "usage_json"    JSONB NOT NULL DEFAULT '{}'::jsonb,
  "summary"       TEXT,
  "error"         TEXT,
  "created_at"    TEXT NOT NULL,
  "started_at"    TEXT,
  "completed_at"  TEXT
);

CREATE INDEX IF NOT EXISTS "idx_research_steps_run"
  ON "research_steps" ("run_id", "created_at");

CREATE INDEX IF NOT EXISTS "idx_research_steps_iteration"
  ON "research_steps" ("run_id", "iteration");

CREATE UNIQUE INDEX IF NOT EXISTS "research_steps_dedupe_unique"
  ON "research_steps" ("run_id", "dedupe_key");

-- Normalized sources: search candidates plus acquired snapshots. The
-- whitespace-normalized snapshot_text is what evidence locators index into.
CREATE TABLE "research_sources" (
  "source_id"               TEXT PRIMARY KEY,
  "run_id"                  TEXT NOT NULL,
  "agent_id"                TEXT NOT NULL,
  "kind"                    TEXT NOT NULL DEFAULT 'web',
  "status"                  TEXT NOT NULL DEFAULT 'candidate',
  "url"                     TEXT,
  "canonical_url"           TEXT,
  "canonical_url_hash"      TEXT,
  "title"                   TEXT,
  "publisher"               TEXT,
  "domain"                  TEXT,
  "author"                  TEXT,
  "published_at"            TEXT,
  "retrieved_at"            TEXT,
  "mime_type"               TEXT,
  "source_class"            TEXT NOT NULL DEFAULT 'unknown',
  "quality_json"            JSONB NOT NULL DEFAULT '{}'::jsonb,
  "metadata_json"           JSONB NOT NULL DEFAULT '{}'::jsonb,
  "discovered_by_step_id"   TEXT NOT NULL,
  "snapshot_text"           TEXT,
  "content_hash"            TEXT,
  "content_bytes"           INTEGER,
  "truncated"               BOOLEAN NOT NULL DEFAULT false,
  "duplicate_of_source_id"  TEXT,
  "last_error"              TEXT,
  "created_at"              TEXT NOT NULL,
  "updated_at"              TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_research_sources_run_status"
  ON "research_sources" ("run_id", "status");

CREATE INDEX IF NOT EXISTS "idx_research_sources_run_domain"
  ON "research_sources" ("run_id", "domain");

CREATE INDEX IF NOT EXISTS "idx_research_sources_run_content_hash"
  ON "research_sources" ("run_id", "content_hash");

-- Prevents repeat acquisition of the same canonical URL within a run.
CREATE UNIQUE INDEX IF NOT EXISTS "research_sources_canonical_unique"
  ON "research_sources" ("run_id", "canonical_url_hash")
  WHERE canonical_url_hash IS NOT NULL;

-- Verified evidence excerpts — the ledger report citations resolve through.
CREATE TABLE "research_evidence" (
  "evidence_id"              TEXT PRIMARY KEY,
  "run_id"                   TEXT NOT NULL,
  "agent_id"                 TEXT NOT NULL,
  "source_id"                TEXT NOT NULL,
  "extraction_step_id"       TEXT NOT NULL,
  "question_ids"             JSONB NOT NULL DEFAULT '[]'::jsonb,
  "excerpt"                  TEXT NOT NULL,
  "locator_json"             JSONB NOT NULL DEFAULT '{}'::jsonb,
  "claim_key"                TEXT,
  "stance"                   TEXT NOT NULL DEFAULT 'context',
  "normalized_value"         TEXT,
  "scope_json"               JSONB NOT NULL DEFAULT '{}'::jsonb,
  "relevance_basis_points"   INTEGER NOT NULL DEFAULT 5000,
  "confidence_basis_points"  INTEGER NOT NULL DEFAULT 5000,
  "out_of_scope"             BOOLEAN NOT NULL DEFAULT false,
  "evidence_hash"            TEXT NOT NULL,
  "created_at"               TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_research_evidence_run_source"
  ON "research_evidence" ("run_id", "source_id");

CREATE INDEX IF NOT EXISTS "idx_research_evidence_run_claim"
  ON "research_evidence" ("run_id", "claim_key");

-- Idempotent evidence inserts across retries and re-extractions.
CREATE UNIQUE INDEX IF NOT EXISTS "research_evidence_hash_unique"
  ON "research_evidence" ("run_id", "evidence_hash");
