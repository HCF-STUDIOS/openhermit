ALTER TABLE "approval_requests" ADD COLUMN "short_id" BIGSERIAL;

CREATE UNIQUE INDEX "idx_approval_requests_short_id" ON "approval_requests" ("short_id");
