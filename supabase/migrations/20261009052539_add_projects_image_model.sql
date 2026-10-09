-- Mirrors IMAGE_MODEL_IDS (src/lib/config/enums.ts). The image model for both element
-- references and Storyboard frames. ADD COLUMN with a NOT NULL default fills every
-- existing row with 'gpt-image-2.5-flare', the model they were generated with.
ALTER TABLE "public"."projects"
    ADD COLUMN "image_model" "text" NOT NULL DEFAULT 'gpt-image-2.5-flare',
    ADD CONSTRAINT "projects_image_model_check" CHECK ("image_model" IN ('gpt-image-2.5-flare', 'gpt-image-2'));
