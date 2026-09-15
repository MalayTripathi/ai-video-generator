-- Allow 'style' as an element type: a style is an element with a name, a
-- description holding the style keywords appended to every image prompt,
-- and an optional reference image. It is never bound to a shot (enforced
-- elsewhere, not by this constraint).
ALTER TABLE "public"."elements" DROP CONSTRAINT "elements_type_check";
ALTER TABLE "public"."elements" ADD CONSTRAINT "elements_type_check"
    CHECK ("type" IN ('character', 'location', 'prop', 'style'));

-- Soft delete: elements are never hard-deleted from this point on. Storage
-- retention policy is undecided and out of scope here.
ALTER TABLE "public"."elements" ADD COLUMN "deleted_at" timestamptz;

-- Name uniqueness must ignore soft-deleted rows so a deleted element's name
-- can be reused. Same transaction as the DROP, so there is no window
-- without a uniqueness guarantee. Not scoped by `type` on purpose — one
-- name namespace per project, matching resolveElement's lower(name)-only
-- in-memory key.
DROP INDEX "public"."elements_project_id_lower_name_key";
CREATE UNIQUE INDEX "elements_project_id_lower_name_key" ON "public"."elements"
    USING btree ("project_id", lower("name")) WHERE ("deleted_at" IS NULL);

-- New operation: generate_element_reference (reference-image generation for
-- an element, at the workbench step) — distinct from storyboard/
-- generate_image, the Step 4 frame render.
ALTER TABLE "public"."usage" DROP CONSTRAINT "usage_operation_check";
ALTER TABLE "public"."usage" ADD CONSTRAINT "usage_operation_check"
    CHECK ("operation" IN ('generate_shots', 'agent_turn', 'voiceover',
        'background_music', 'write_image_prompts', 'write_video_prompts',
        'generate_image', 'generate_clip', 'merge', 'derive_camera',
        'generate_element_reference'));

ALTER TABLE "public"."credit_ledger" DROP CONSTRAINT "credit_ledger_operation_check";
ALTER TABLE "public"."credit_ledger" ADD CONSTRAINT "credit_ledger_operation_check"
    CHECK ("operation" IS NULL OR "operation" IN ('generate_shots', 'agent_turn',
        'voiceover', 'background_music', 'write_image_prompts',
        'write_video_prompts', 'generate_image', 'generate_clip', 'merge',
        'derive_camera', 'generate_element_reference'));

ALTER TABLE "public"."generations" DROP CONSTRAINT "generations_operation_check";
ALTER TABLE "public"."generations" ADD CONSTRAINT "generations_operation_check"
    CHECK ("operation" IN ('generate_shots', 'agent_turn', 'voiceover',
        'background_music', 'write_image_prompts', 'write_video_prompts',
        'generate_image', 'generate_clip', 'merge',
        'generate_element_reference'));
