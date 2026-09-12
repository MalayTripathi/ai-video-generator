-- generations_operation_check mirrors src/lib/config/pipeline.ts's OPERATIONS by hand -
-- Postgres can't import a TS module, so this stays a manual sync, guarded by
-- tests/enums-drift.spec.ts (fails the suite if this constraint and OPERATIONS diverge).
--
-- write_prompts was a leftover from a deprecated Step 3 implementation and conflated two
-- distinct steps (image_prompts and video_prompts) under one value - the same ambiguity
-- that makes /api/projects/[id]/prompts under-report Step 5 spend as zero. Zero rows ever
-- carried this value (confirmed before writing this migration), so it splits cleanly into
-- write_image_prompts and write_video_prompts with no data to migrate.
--
-- derive_camera is still deliberately excluded here, unchanged - see
-- 20260902200658_add_derive_camera_operation.sql: no writer will ever insert a
-- generations row with that operation, and widening this constraint would misleadingly
-- imply otherwise.
ALTER TABLE "public"."generations" DROP CONSTRAINT "generations_operation_check";
ALTER TABLE "public"."generations" ADD CONSTRAINT "generations_operation_check"
    CHECK ("operation" IN ('generate_shots', 'agent_turn', 'voiceover', 'background_music',
                            'write_image_prompts', 'write_video_prompts', 'generate_image',
                            'generate_clip', 'merge'));
