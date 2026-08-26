ALTER TABLE "public"."projects"
    ADD COLUMN "source_text" "text",
    ADD COLUMN "video_type" "text",
    ADD COLUMN "aspect_ratio" "text",
    ADD COLUMN "duration_target" "text",
    ADD COLUMN "language" "text",
    ADD COLUMN "template_source_id" "uuid",
    ADD COLUMN "video_model" "text";

ALTER TABLE ONLY "public"."projects"
    ADD CONSTRAINT "projects_template_source_id_fkey" FOREIGN KEY ("template_source_id") REFERENCES "public"."projects"("id") ON DELETE SET NULL;

UPDATE "public"."projects"
SET "aspect_ratio" = COALESCE("aspect_ratio", '9:16'),
    "duration_target" = COALESCE("duration_target", '1-2min'),
    "video_type" = COALESCE("video_type", 'auto'),
    "language" = COALESCE("language", 'en');

ALTER TABLE "public"."projects"
    ADD CONSTRAINT "projects_aspect_ratio_check" CHECK ("aspect_ratio" IN ('9:16', '16:9', '1:1')),
    ADD CONSTRAINT "projects_duration_target_check" CHECK ("duration_target" IN ('30-60s', '1-2min', '3-5min', '8-10min')),
    ADD CONSTRAINT "projects_video_type_check" CHECK ("video_type" IN ('auto', 'narrated_story', 'explainer', 'facts_listicle', 'character_drama', 'product_ad', 'trailer'));

CREATE INDEX "projects_template_source_id_idx" ON "public"."projects" USING "btree" ("template_source_id");
