-- Phase 1 prompt 2: the shots route's claim moves from projects.shots_generation /
-- projects.pending_shots_payload onto the generations table's insert-to-claim
-- pattern. Backfill every project's existing state into a generations row before
-- dropping the two columns, so a project mid-flight (or already 'ready') isn't read
-- by the new code as a degraded/never-attempted state.
--
-- 'ready' becomes 'succeeded' - the one place this rename happens; everything else in
-- the CASE passes the value straight through, since 'pending'/'generating'/'failed'
-- are unchanged between the two vocabularies.
INSERT INTO "public"."generations" (
    "project_id", "step", "operation", "shot_id",
    "state", "payload", "started_at", "created_at", "updated_at"
)
SELECT
    "id", 'workbench', 'generate_shots', NULL,
    CASE "shots_generation" WHEN 'ready' THEN 'succeeded' ELSE "shots_generation" END,
    "pending_shots_payload", now(), now(), now()
FROM "public"."projects"
WHERE "shots_generation" IS NOT NULL;

ALTER TABLE "public"."projects"
    DROP COLUMN "shots_generation",
    DROP COLUMN "pending_shots_payload";
