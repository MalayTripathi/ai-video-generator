-- The current `usage` table predates the fixes this migration encodes and
-- is known to under-count spend (no user_id, no model, no status - see
-- CLAUDE.md's prior `usage` "Known gaps" note). Its rows are discarded
-- deliberately; nothing downstream reconciles against them.
DROP TABLE IF EXISTS "public"."usage";

CREATE TABLE "public"."usage" (
    "id" uuid DEFAULT gen_random_uuid() NOT NULL,
    "user_id" uuid NOT NULL,
    "project_id" uuid,
    "generation_id" uuid,
    "message_id" uuid,
    "shot_id" uuid,
    "step" text NOT NULL,
    "operation" text NOT NULL,
    "provider" text NOT NULL,
    "model" text NOT NULL,
    "status" text DEFAULT 'pending' NOT NULL,
    "stop_reason" text,
    "quantity" numeric,
    "unit" text,
    "raw_usage" jsonb,
    "rate_version" text,
    "estimated_cost" numeric(12,6),
    "created_at" timestamptz DEFAULT now() NOT NULL,
    "updated_at" timestamptz DEFAULT now() NOT NULL
);

ALTER TABLE ONLY "public"."usage"
    ADD CONSTRAINT "usage_pkey" PRIMARY KEY ("id");

-- user_id is denormalized on purpose: it must survive project deletion
-- (see project_id below) so billing history isn't lost with the project.
ALTER TABLE ONLY "public"."usage"
    ADD CONSTRAINT "usage_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."usage"
    ADD CONSTRAINT "usage_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE SET NULL;

ALTER TABLE ONLY "public"."usage"
    ADD CONSTRAINT "usage_generation_id_fkey" FOREIGN KEY ("generation_id") REFERENCES "public"."generations"("id") ON DELETE SET NULL;

-- message_id is a separate grouping dimension from generation_id (a row
-- may carry both, either, or neither) - deliberately not part of any
-- unique constraint, since multiple usage rows may legitimately share
-- one agent-chat message_id.
ALTER TABLE ONLY "public"."usage"
    ADD CONSTRAINT "usage_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE SET NULL;

ALTER TABLE ONLY "public"."usage"
    ADD CONSTRAINT "usage_shot_id_fkey" FOREIGN KEY ("shot_id") REFERENCES "public"."shots"("id") ON DELETE SET NULL;

-- step/operation/provider mirror src/lib/config/pipeline.ts - see the
-- generations migration's identical note. stop_reason is data, not a
-- status: a max_tokens truncation settles status='failed' with
-- stop_reason='max_tokens', it never becomes its own status value.
ALTER TABLE ONLY "public"."usage"
    ADD CONSTRAINT "usage_step_check" CHECK ("step" IN ('workbench', 'voiceover', 'image_prompts', 'video_prompts', 'generation', 'assembly')),
    ADD CONSTRAINT "usage_operation_check" CHECK ("operation" IN ('generate_shots', 'agent_turn', 'voiceover', 'background_music', 'write_prompts', 'generate_image', 'generate_clip', 'merge')),
    ADD CONSTRAINT "usage_provider_check" CHECK ("provider" IN ('anthropic', 'openai', 'elevenlabs', 'fal')),
    ADD CONSTRAINT "usage_status_check" CHECK ("status" IN ('pending', 'succeeded', 'failed'));

COMMENT ON COLUMN "public"."usage"."estimated_cost" IS
    'Reserve-then-settle: written on INSERT with the pre-flight quote, overwritten on settle with the measured cost. Never null while pending - a per-user spend cap sums this across in-flight + settled rows, so a null pending row would make concurrent spend invisible to that check.';

CREATE INDEX "usage_user_id_created_at_idx" ON "public"."usage" USING btree ("user_id", "created_at" DESC);
CREATE INDEX "usage_project_id_idx" ON "public"."usage" USING btree ("project_id");
CREATE INDEX "usage_generation_id_idx" ON "public"."usage" USING btree ("generation_id");
CREATE INDEX "usage_message_id_idx" ON "public"."usage" USING btree ("message_id");

ALTER TABLE "public"."usage" ENABLE ROW LEVEL SECURITY;

-- Deviation from the child-table pattern used elsewhere (jobs/messages/
-- shots/elements/generations all resolve ownership through an EXISTS-on-
-- projects subquery, because those tables have no user_id of their own).
-- `usage` carries user_id directly, and its policy follows a direct
-- user_id = auth.uid() check rather than joining through projects -
-- project_id is nullable (ON DELETE SET NULL) specifically so billing
-- history survives project deletion, and a join-based policy would deny
-- a user access to their own orphaned billing rows the moment the
-- project is gone, defeating the reason the column is nullable.
CREATE POLICY "users can view their own usage" ON "public"."usage"
    FOR SELECT USING (user_id = auth.uid());

-- The project_id/exists check here is a data-integrity guard, not a
-- security one (user_id = auth.uid() alone already fully secures the
-- row) - it guarantees that when project_id is set, it actually belongs
-- to the inserting user, so a future "cost per project" query joining
-- usage to projects always returns meaningful results.
CREATE POLICY "users can insert their own usage" ON "public"."usage"
    FOR INSERT WITH CHECK (
        user_id = auth.uid()
        AND (
            project_id IS NULL
            OR EXISTS (
                SELECT 1 FROM "public"."projects" p
                WHERE p.id = project_id AND p.user_id = auth.uid()
            )
        )
    );

-- Rows are written 'pending' before the provider call and settled
-- (status, estimated_cost, etc.) afterwards - without this policy,
-- settling fails silently under RLS, same reasoning as generations'
-- UPDATE policy.
CREATE POLICY "users can update their own usage" ON "public"."usage"
    FOR UPDATE USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

GRANT ALL ON TABLE "public"."usage" TO "anon", "authenticated", "service_role";
