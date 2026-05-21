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

-- Re-key user skills first in agent_skills, then in skills itself. Order
-- matters: the join needs the old slug to still be present on skills.id.
-- Catch every assignment regardless of whose agent_id is on the row, since
-- admin endpoints can cross-enable a user skill onto another agent.
UPDATE "agent_skills" AS a
SET "skill_id" = 'user:' || s."owner_agent_id" || ':' || s."id"
FROM "skills" AS s
WHERE s."source" = 'user'
  AND s."id" = a."skill_id";

UPDATE "skills"
SET "id" = 'user:' || "owner_agent_id" || ':' || "slug"
WHERE "source" = 'user';

CREATE UNIQUE INDEX "skills_system_slug_unique"
  ON "skills" ("slug")
  WHERE "source" = 'system';

CREATE UNIQUE INDEX "skills_user_owner_slug_unique"
  ON "skills" ("owner_agent_id", "slug")
  WHERE "source" = 'user';
