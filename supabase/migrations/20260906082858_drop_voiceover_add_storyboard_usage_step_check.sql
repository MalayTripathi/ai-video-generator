-- usage_step_check mirrors src/lib/config/pipeline.ts's STEPS by hand - see the
-- generations migration's identical note. Same edit: 'voiceover' out, 'storyboard' in,
-- storyboard now being a spending step.
--
-- usage_operation_check is NOT touched: it enumerates bare operation names with no step
-- pairing, so moving voiceover/background_music under storyboard does not affect it.
ALTER TABLE "public"."usage" DROP CONSTRAINT "usage_step_check";

ALTER TABLE "public"."usage" ADD CONSTRAINT "usage_step_check"
    CHECK ("step" IN ('workbench', 'image_prompts', 'storyboard',
                      'video_prompts', 'generation', 'assembly'));
