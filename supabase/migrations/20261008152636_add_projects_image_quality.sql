-- Mirrors IMAGE_QUALITIES (src/lib/config/enums.ts).
ALTER TABLE "public"."projects"
    ADD COLUMN "image_quality" "text" NOT NULL DEFAULT 'low',
    ADD CONSTRAINT "projects_image_quality_check" CHECK ("image_quality" IN ('low', 'medium', 'high'));
