-- Shot-generation state machine on `projects`, replacing "the shots table
-- is empty" as the trigger for shot generation with an explicit status.
--
-- pending    = intake has created the row, shot generation has not run yet.
-- generating = a claim is held; `generating_at` holds the claim timestamp.
-- ready      = shots exist and are committed.
-- failed     = the last attempt failed. `pending_shots_payload` is non-null
--              if and only if Claude already returned successfully and
--              only the database writes failed, in which case recovery
--              must replay the payload and MUST NOT call Claude again.
--
-- `pending_shots_payload` is always cleared once shots and shot_elements
-- are committed. `generating_at` (added in
-- 20260819130239_add_projects_generating_at.sql) is untouched here - it
-- remains the claim timestamp, now written in the same UPDATE that
-- transitions `shots_generation` to 'generating'.

ALTER TABLE "public"."projects"
    ADD COLUMN "shots_generation" text DEFAULT 'pending'::text NOT NULL,
    ADD COLUMN "pending_shots_payload" jsonb;

ALTER TABLE "public"."projects"
    ADD CONSTRAINT "projects_shots_generation_check" CHECK ("shots_generation" IN ('pending', 'generating', 'ready', 'failed'));

-- One-time backfill: projects that already have committed shots are
-- 'ready'. Everything else keeps the 'pending' default.
UPDATE "public"."projects"
SET "shots_generation" = 'ready'
WHERE EXISTS (
    SELECT 1 FROM "public"."shots" WHERE "shots"."project_id" = "projects"."id"
);
