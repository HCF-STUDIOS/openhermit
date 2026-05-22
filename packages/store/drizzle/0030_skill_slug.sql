-- Allow user skills with the same slug to coexist across different owners.
-- Two agents owned by different users should each be able to install a user
-- skill named e.g. "weread-helper" without colliding on the global `id` PK.
--
-- New layout:
--   * `slug` (new column) is the user-visible identifier — the folder name
--     synced into <agentHome>/.openhermit/skills/{system,user}/<slug>/ and
--     the id the LLM sees in the prompt index.
--   * `id` remains the storage PK, but for user skills it is now encoded as
--     `user:<owner_agent_id>:<slug>` so the same slug can appear under
--     different owners.
--   * Partial unique indexes preserve the invariant that slugs are unique
--     within each scope: globally for system skills, per-owner for user
--     skills.

ALTER TABLE "skills" ADD COLUMN "slug" text;

UPDATE "skills" SET "slug" = "id";

ALTER TABLE "skills" ALTER COLUMN "slug" SET NOT NULL;

-- Re-key user skills. The FK agent_skills.skill_id -> skills.id is declared
-- ON UPDATE CASCADE, so updating skills.id propagates to every referencing
-- agent_skills row in the same statement. An earlier draft of this file
-- also issued an explicit UPDATE on agent_skills first, which violated the
-- FK because the new id did not yet exist in skills at that point.
UPDATE "skills"
SET "id" = 'user:' || "owner_agent_id" || ':' || "slug"
WHERE "source" = 'user';

CREATE UNIQUE INDEX "skills_system_slug_unique"
  ON "skills" ("slug")
  WHERE "source" = 'system';

CREATE UNIQUE INDEX "skills_user_owner_slug_unique"
  ON "skills" ("owner_agent_id", "slug")
  WHERE "source" = 'user';
