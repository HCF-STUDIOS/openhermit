-- Distinguish operator-managed system skills from owner-installed user skills.
-- `source` selects which subdir under <agentHome>/.openhermit/skills/ the skill
-- is synced into (system/ vs user/). `owner_agent_id` records who installed a
-- user skill; skill_install/skill_uninstall use it to gate access so an owner
-- can only manage their own skills, never a system or peer skill.
ALTER TABLE "skills"
  ADD COLUMN "source" text NOT NULL DEFAULT 'system';

ALTER TABLE "skills"
  ADD CONSTRAINT "skills_source_check"
  CHECK ("source" IN ('system', 'user'));

ALTER TABLE "skills"
  ADD COLUMN "owner_agent_id" text;

CREATE INDEX "idx_skills_owner_agent" ON "skills" ("owner_agent_id");
