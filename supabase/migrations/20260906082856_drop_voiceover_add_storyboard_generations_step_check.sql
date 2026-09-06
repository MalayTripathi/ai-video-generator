-- generations_step_check mirrors src/lib/config/pipeline.ts's STEPS by hand. That array
-- dropped 'voiceover' and gained 'storyboard', which absorbed the voiceover step and now
-- owns three paid operations (generate_image, voiceover, background_music) - so a
-- storyboard claim must be insertable.
--
-- generations_operation_check is NOT touched: it enumerates bare operation names with no
-- step pairing, so relocating an operation between steps does not affect it. The
-- (step, operation) pairing lives in STEP_OPERATIONS and stays app-enforced.
ALTER TABLE "public"."generations" DROP CONSTRAINT "generations_step_check";

ALTER TABLE "public"."generations" ADD CONSTRAINT "generations_step_check"
    CHECK ("step" IN ('workbench', 'image_prompts', 'storyboard',
                      'video_prompts', 'generation', 'assembly'));
