-- Reusable elements (character/location/prop) so a recurring character gets
-- one reference image reused across shots instead of a fresh render per
-- shot. Case-insensitive unique name per project enforces that reuse.

CREATE TABLE "public"."elements" (
    "id" uuid DEFAULT gen_random_uuid() NOT NULL,
    "project_id" uuid NOT NULL,
    "name" text NOT NULL,
    "type" text NOT NULL,
    "description" text,
    "reference_image_path" text,
    "status" text DEFAULT 'pending' NOT NULL,
    "created_at" timestamptz DEFAULT now() NOT NULL
);

ALTER TABLE ONLY "public"."elements"
    ADD CONSTRAINT "elements_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."elements"
    ADD CONSTRAINT "elements_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."elements"
    ADD CONSTRAINT "elements_type_check" CHECK ("type" IN ('character', 'location', 'prop')),
    ADD CONSTRAINT "elements_status_check" CHECK ("status" IN ('pending', 'generating', 'ready', 'failed'));

CREATE UNIQUE INDEX "elements_project_id_lower_name_key" ON "public"."elements" USING btree ("project_id", lower("name"));

ALTER TABLE "public"."elements" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users manage elements in their own projects" ON "public"."elements"
    USING (EXISTS (
        SELECT 1 FROM "public"."projects"
        WHERE "projects"."id" = "elements"."project_id" AND "projects"."user_id" = auth.uid()
    ));

GRANT ALL ON TABLE "public"."elements" TO "anon", "authenticated", "service_role";

-- Join table: which elements appear in which shots.
CREATE TABLE "public"."shot_elements" (
    "shot_id" uuid NOT NULL,
    "element_id" uuid NOT NULL
);

ALTER TABLE ONLY "public"."shot_elements"
    ADD CONSTRAINT "shot_elements_pkey" PRIMARY KEY ("shot_id", "element_id");

ALTER TABLE ONLY "public"."shot_elements"
    ADD CONSTRAINT "shot_elements_shot_id_fkey" FOREIGN KEY ("shot_id") REFERENCES "public"."shots"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."shot_elements"
    ADD CONSTRAINT "shot_elements_element_id_fkey" FOREIGN KEY ("element_id") REFERENCES "public"."elements"("id") ON DELETE CASCADE;

ALTER TABLE "public"."shot_elements" ENABLE ROW LEVEL SECURITY;

-- Ownership resolves through shots -> projects (two-level join), unlike the
-- single-level pattern used by every other child table.
CREATE POLICY "users manage shot_elements in their own projects" ON "public"."shot_elements"
    USING (EXISTS (
        SELECT 1 FROM "public"."shots"
        JOIN "public"."projects" ON "projects"."id" = "shots"."project_id"
        WHERE "shots"."id" = "shot_elements"."shot_id" AND "projects"."user_id" = auth.uid()
    ));

GRANT ALL ON TABLE "public"."shot_elements" TO "anon", "authenticated", "service_role";
