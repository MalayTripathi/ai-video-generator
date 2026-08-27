-- Rename scenes -> shots, including its ordering/key columns, and every
-- constraint, index, and RLS policy that Postgres does not rename for us.
-- Also renames jobs.scene_id -> jobs.shot_id and its FK.

ALTER TABLE "public"."scenes" RENAME TO "shots";
ALTER TABLE "public"."shots" RENAME COLUMN "position" TO "order_index";
ALTER TABLE "public"."shots" RENAME COLUMN "scene_key" TO "shot_key";

ALTER TABLE "public"."shots" RENAME CONSTRAINT "scenes_pkey" TO "shots_pkey";
ALTER TABLE "public"."shots" RENAME CONSTRAINT "scenes_project_id_position_key" TO "shots_project_id_order_index_key";
ALTER INDEX "public"."scenes_project_id_position_idx" RENAME TO "shots_project_id_order_index_idx";
ALTER TABLE "public"."shots" RENAME CONSTRAINT "scenes_project_id_fkey" TO "shots_project_id_fkey";

ALTER POLICY "users manage scenes in their own projects" ON "public"."shots"
    RENAME TO "users manage shots in their own projects";

ALTER TABLE "public"."jobs" RENAME COLUMN "scene_id" TO "shot_id";
ALTER TABLE "public"."jobs" RENAME CONSTRAINT "jobs_scene_id_fkey" TO "jobs_shot_id_fkey";
