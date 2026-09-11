-- The user-facing credit ledger - the platform's currency, fully independent of
-- `usage` (dollar-denominated admin instrumentation only): no FK, no column, no
-- join to `usage` in either direction. Rows are immutable - nothing ever updates
-- or deletes one; a refund is a new row, never a modification of the refunded one.
-- Balance is SUM(delta) - there is no balance_after or sequence column, since a
-- stored running total is a second source of truth that drifts under concurrent
-- inserts. Granularity is one row per user action, not per provider call (an agent
-- turn making six Claude calls produces six `usage` rows and one ledger row).
--
-- Schema only in this migration - no application code reads or writes this table
-- yet. All writes will go through a service-role client (none exists in src/ yet;
-- that's a later task's problem, not this one's).
CREATE TABLE "public"."credit_ledger" (
    "id" uuid DEFAULT gen_random_uuid() NOT NULL,
    "user_id" uuid NOT NULL,
    "created_at" timestamptz DEFAULT now() NOT NULL,
    "kind" text NOT NULL,
    "delta" integer NOT NULL,
    "step" text,
    "operation" text,
    "project_id" uuid,
    "message_id" uuid,
    "shot_key" text,
    "attempt_id" uuid,
    "dedupe_key" text NOT NULL,
    "price_version" text NOT NULL,
    "pricing_mode" text,
    "refunds_ledger_id" uuid
);

ALTER TABLE ONLY "public"."credit_ledger"
    ADD CONSTRAINT "credit_ledger_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."credit_ledger"
    ADD CONSTRAINT "credit_ledger_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;

-- Set-null, not cascade: projects aren't hard-deleted today, but a cascade here
-- would silently erase spend history if that ever changed. A ledger row must
-- outlive whatever it paid for.
ALTER TABLE ONLY "public"."credit_ledger"
    ADD CONSTRAINT "credit_ledger_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE SET NULL;

ALTER TABLE ONLY "public"."credit_ledger"
    ADD CONSTRAINT "credit_ledger_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE SET NULL;

-- Self-FK for a refund's back-reference to the row it refunds. No ON DELETE clause
-- (defaults to NO ACTION) - rows are immutable and never deleted, so this is never
-- exercised, but a self-referencing FK still has to name something.
ALTER TABLE ONLY "public"."credit_ledger"
    ADD CONSTRAINT "credit_ledger_refunds_ledger_id_fkey" FOREIGN KEY ("refunds_ledger_id") REFERENCES "public"."credit_ledger"("id");

-- shot_key deliberately gets no FK, following messages.shot_key's precedent
-- (20260908110402_add_messages_kind_shot_key_tool_name.sql): a deleted shot must
-- not erase the record that credits were spent on it.

-- step/operation mirror src/lib/config/pipeline.ts's STEPS/OPERATIONS by hand -
-- Postgres can't import a TS module, so this stays a manual sync, guarded by
-- tests/enums-drift.spec.ts (fails the suite if either constraint and its array
-- diverge). Both are nullable here (only a 'spend' row requires them - see the
-- kind-conditional checks below), unlike generations/usage where they're NOT NULL.
ALTER TABLE ONLY "public"."credit_ledger"
    ADD CONSTRAINT "credit_ledger_kind_check" CHECK ("kind" IN ('signup_grant', 'spend', 'refund', 'adjustment')),
    ADD CONSTRAINT "credit_ledger_step_check" CHECK ("step" IS NULL OR "step" IN ('workbench', 'image_prompts', 'storyboard', 'video_prompts', 'generation', 'assembly')),
    ADD CONSTRAINT "credit_ledger_operation_check" CHECK ("operation" IS NULL OR "operation" IN ('generate_shots', 'agent_turn', 'voiceover', 'background_music', 'write_image_prompts', 'write_video_prompts', 'generate_image', 'generate_clip', 'merge', 'derive_camera')),
    ADD CONSTRAINT "credit_ledger_pricing_mode_check" CHECK ("pricing_mode" IS NULL OR "pricing_mode" IN ('fixed', 'dynamic'));

-- delta/kind sign and completeness rules. 'adjustment' is deliberately excluded
-- from the sign checks below - it exists for manual correction in either direction.
ALTER TABLE ONLY "public"."credit_ledger"
    ADD CONSTRAINT "credit_ledger_delta_nonzero_check" CHECK ("delta" <> 0),
    ADD CONSTRAINT "credit_ledger_spend_negative_check" CHECK ("kind" <> 'spend' OR "delta" < 0),
    ADD CONSTRAINT "credit_ledger_grant_refund_positive_check" CHECK ("kind" NOT IN ('signup_grant', 'refund') OR "delta" > 0),
    ADD CONSTRAINT "credit_ledger_spend_fields_check" CHECK ("kind" <> 'spend' OR ("step" IS NOT NULL AND "operation" IS NOT NULL AND "attempt_id" IS NOT NULL AND "pricing_mode" IS NOT NULL)),
    ADD CONSTRAINT "credit_ledger_refund_ref_check" CHECK ("refunds_ledger_id" IS NULL OR "kind" = 'refund');

-- The write guard: {operation}:{attempt_id} for spends, signup_grant:{user_id} for
-- the grant, scoped per-user so two different users can share a dedupe_key.
CREATE UNIQUE INDEX "credit_ledger_user_id_dedupe_key_idx" ON "public"."credit_ledger" USING btree ("user_id", "dedupe_key");

-- Balance and history reads. Display ordering is created_at with id as tiebreak -
-- no separate index needed for that, since id is already the primary key.
CREATE INDEX "credit_ledger_user_id_created_at_idx" ON "public"."credit_ledger" USING btree ("user_id", "created_at");
CREATE INDEX "credit_ledger_project_id_idx" ON "public"."credit_ledger" USING btree ("project_id");
CREATE INDEX "credit_ledger_message_id_idx" ON "public"."credit_ledger" USING btree ("message_id");

ALTER TABLE "public"."credit_ledger" ENABLE ROW LEVEL SECURITY;

-- Direct user_id = auth.uid() check, not a join through projects - matches usage's
-- reasoning exactly (20260831095628_drop_and_recreate_usage.sql): project_id is
-- nullable here too, and a join-based policy would deny a user their own
-- project-less ledger rows.
CREATE POLICY "users can view their own credit ledger" ON "public"."credit_ledger"
    FOR SELECT USING (user_id = auth.uid());

-- Deliberately no INSERT/UPDATE/DELETE policy for authenticated - every write goes
-- through a service-role client, which bypasses RLS entirely. Do not add one.

GRANT ALL ON TABLE "public"."credit_ledger" TO "anon", "authenticated", "service_role";
