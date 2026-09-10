-- usage_operation_check mirrors src/lib/config/pipeline.ts's OPERATIONS by hand - see the
-- generations migration's identical note. This stays a manual sync, guarded by
-- tests/enums-drift.spec.ts (fails the suite if this constraint and OPERATIONS diverge).
--
-- Same rename as generations_operation_check: write_prompts -> write_image_prompts /
-- write_video_prompts. derive_camera stays present, unchanged, from
-- 20260902200658_add_derive_camera_operation.sql.
ALTER TABLE "public"."usage" DROP CONSTRAINT "usage_operation_check";
ALTER TABLE "public"."usage" ADD CONSTRAINT "usage_operation_check"
    CHECK ("operation" IN ('generate_shots', 'agent_turn', 'voiceover', 'background_music',
                            'write_image_prompts', 'write_video_prompts', 'generate_image',
                            'generate_clip', 'merge', 'derive_camera'));
