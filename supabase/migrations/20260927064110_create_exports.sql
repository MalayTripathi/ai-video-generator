-- Export jobs (Storyboard F): one row per "Export slideshow" request, rendered by the
-- standalone worker in worker/. History needs rows, so this is a table, not project
-- columns. Exports are free and re-renderable: the worker keeps the last few succeeded
-- rows per project and deletes older ones with their files.
--
-- settings is the resolved export settings at request time (a retry reuses it);
-- film_hash identifies the film that was rendered, so the page can flag an export whose
-- film has since been edited. status mirrors EXPORT_STATUSES in
-- src/lib/config/enums.ts by hand, guarded by tests/enums-drift.spec.ts.
CREATE TABLE "public"."exports" (
    "id" uuid DEFAULT gen_random_uuid() NOT NULL,
    "user_id" uuid NOT NULL,
    "project_id" uuid NOT NULL,
    "status" text DEFAULT 'queued' NOT NULL,
    "settings" jsonb NOT NULL,
    "film_hash" text NOT NULL,
    "progress" smallint DEFAULT 0 NOT NULL,
    "error" text,
    "mp4_path" text,
    "srt_path" text,
    "chapters_path" text,
    "size_bytes" bigint,
    "duration_sec" numeric,
    "created_at" timestamptz DEFAULT now() NOT NULL,
    "started_at" timestamptz,
    "finished_at" timestamptz
);

ALTER TABLE ONLY "public"."exports" ADD CONSTRAINT "exports_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "public"."exports" ADD CONSTRAINT "exports_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;
-- Cascade, unlike usage/credit_ledger: an export is free and not billing history.
ALTER TABLE ONLY "public"."exports" ADD CONSTRAINT "exports_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;
ALTER TABLE ONLY "public"."exports"
    ADD CONSTRAINT "exports_status_check" CHECK ("status" IN ('queued', 'rendering', 'succeeded', 'failed', 'cancelled')),
    ADD CONSTRAINT "exports_progress_check" CHECK ("progress" BETWEEN 0 AND 100);

CREATE INDEX "exports_project_id_created_at_idx" ON "public"."exports" USING btree ("project_id", "created_at");
CREATE INDEX "exports_status_created_at_idx" ON "public"."exports" USING btree ("status", "created_at");

ALTER TABLE "public"."exports" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users can view their own exports" ON "public"."exports"
    FOR SELECT USING (user_id = auth.uid());

-- Deliberately no INSERT/UPDATE/DELETE policy for authenticated - the app's routes and
-- the worker write through a service-role client, which bypasses RLS. Do not add one.

GRANT ALL ON TABLE "public"."exports" TO "anon", "authenticated", "service_role";
