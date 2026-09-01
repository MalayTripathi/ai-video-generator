-- Step 7 (clip generation) pre-provisioned `jobs` ahead of any app code
-- ever writing to it (confirmed empty, zero src/ references - see
-- CLAUDE.md's `generations` note). It's replaced before first use by
-- `generations`, a general claim/lock table for every operation that
-- fires a paid external API call - not just clip generation.
DROP TABLE IF EXISTS "public"."jobs";

CREATE TABLE "public"."generations" (
    "id" uuid DEFAULT gen_random_uuid() NOT NULL,
    "project_id" uuid NOT NULL,
    "shot_id" uuid,
    "step" text NOT NULL,
    "operation" text NOT NULL,
    "state" text DEFAULT 'pending' NOT NULL,
    "payload" jsonb,
    "error" text,
    "external_id" text,
    "started_at" timestamptz,
    "created_at" timestamptz DEFAULT now() NOT NULL,
    "updated_at" timestamptz DEFAULT now() NOT NULL
);

ALTER TABLE ONLY "public"."generations"
    ADD CONSTRAINT "generations_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."generations"
    ADD CONSTRAINT "generations_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."generations"
    ADD CONSTRAINT "generations_shot_id_fkey" FOREIGN KEY ("shot_id") REFERENCES "public"."shots"("id") ON DELETE CASCADE;

-- Mirrors src/lib/config/pipeline.ts's STEPS/OPERATIONS - keep in sync by
-- hand; Postgres CHECK constraints can't import a TS module. These two
-- checks validate step and operation independently; STEP_OPERATIONS'
-- pairing (which operations are valid for which step) is enforced only
-- in application code, matching the existing convention that
-- projects.current_step's vocabulary is app-enforced.
ALTER TABLE ONLY "public"."generations"
    ADD CONSTRAINT "generations_step_check" CHECK ("step" IN ('workbench', 'voiceover', 'image_prompts', 'video_prompts', 'generation', 'assembly')),
    ADD CONSTRAINT "generations_operation_check" CHECK ("operation" IN ('generate_shots', 'agent_turn', 'voiceover', 'background_music', 'write_prompts', 'generate_image', 'generate_clip', 'merge')),
    ADD CONSTRAINT "generations_state_check" CHECK ("state" IN ('pending', 'generating', 'succeeded', 'failed'));

-- Load-bearing: a project-level claim (shot_id null) and a per-shot claim
-- must each be unique per (project_id, step, operation). NULLS NOT
-- DISTINCT (PG15+, this project is on 17.6.1) makes every null shot_id
-- collide with every other null instead of comparing distinct, so a
-- second concurrent project-level claim for the same (step, operation)
-- is rejected by the index instead of racing.
CREATE UNIQUE INDEX "generations_identity_idx" ON "public"."generations" USING btree ("project_id", "step", "operation", "shot_id") NULLS NOT DISTINCT;

CREATE INDEX "generations_project_id_step_idx" ON "public"."generations" USING btree ("project_id", "step");

CREATE INDEX "generations_state_started_at_idx" ON "public"."generations" USING btree ("state", "started_at");

ALTER TABLE "public"."generations" ENABLE ROW LEVEL SECURITY;

-- Split into SELECT/INSERT/UPDATE (not one blanket policy): the claim
-- pattern this table exists for inserts a row to claim, then writes to
-- the same row again to settle it - an explicit UPDATE policy is not
-- optional, or that settle write fails silently under RLS. Ownership
-- mirrors shots's project-exists subquery.
CREATE POLICY "users can view generations in their own projects" ON "public"."generations"
    FOR SELECT USING (EXISTS (
        SELECT 1 FROM "public"."projects"
        WHERE "projects"."id" = "generations"."project_id" AND "projects"."user_id" = auth.uid()
    ));

CREATE POLICY "users can insert generations in their own projects" ON "public"."generations"
    FOR INSERT WITH CHECK (EXISTS (
        SELECT 1 FROM "public"."projects"
        WHERE "projects"."id" = "generations"."project_id" AND "projects"."user_id" = auth.uid()
    ));

CREATE POLICY "users can update generations in their own projects" ON "public"."generations"
    FOR UPDATE USING (EXISTS (
        SELECT 1 FROM "public"."projects"
        WHERE "projects"."id" = "generations"."project_id" AND "projects"."user_id" = auth.uid()
    )) WITH CHECK (EXISTS (
        SELECT 1 FROM "public"."projects"
        WHERE "projects"."id" = "generations"."project_id" AND "projects"."user_id" = auth.uid()
    ));

GRANT ALL ON TABLE "public"."generations" TO "anon", "authenticated", "service_role";
