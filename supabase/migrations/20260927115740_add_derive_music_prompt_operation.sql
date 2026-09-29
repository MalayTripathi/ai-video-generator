-- New operation: derive_music_prompt (the one-line music style prompt, derived once per
-- project at the storyboard). Mirrors OPERATIONS in src/lib/config/pipeline.ts. The
-- generations list still omits derive_camera, which never writes a claim row.
ALTER TABLE "public"."usage" DROP CONSTRAINT "usage_operation_check";
ALTER TABLE "public"."usage" ADD CONSTRAINT "usage_operation_check"
    CHECK ("operation" IN ('generate_shots', 'agent_turn', 'voiceover',
        'background_music', 'write_image_prompts', 'write_video_prompts',
        'generate_image', 'generate_clip', 'merge', 'derive_camera',
        'generate_element_reference', 'align_voiceover', 'derive_music_prompt'));

ALTER TABLE "public"."credit_ledger" DROP CONSTRAINT "credit_ledger_operation_check";
ALTER TABLE "public"."credit_ledger" ADD CONSTRAINT "credit_ledger_operation_check"
    CHECK ("operation" IS NULL OR "operation" IN ('generate_shots', 'agent_turn',
        'voiceover', 'background_music', 'write_image_prompts',
        'write_video_prompts', 'generate_image', 'generate_clip', 'merge',
        'derive_camera', 'generate_element_reference', 'align_voiceover',
        'derive_music_prompt'));

ALTER TABLE "public"."generations" DROP CONSTRAINT "generations_operation_check";
ALTER TABLE "public"."generations" ADD CONSTRAINT "generations_operation_check"
    CHECK ("operation" IN ('generate_shots', 'agent_turn', 'voiceover',
        'background_music', 'write_image_prompts', 'write_video_prompts',
        'generate_image', 'generate_clip', 'merge',
        'generate_element_reference', 'align_voiceover', 'derive_music_prompt'));
