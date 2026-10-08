-- Every existing project takes the 'low' quality preset (QUALITY_PRESETS.low,
-- src/lib/config/models.ts). video_model deliberately has no CHECK: it is validated
-- in application code against VIDEO_MODELS.
UPDATE "public"."projects"
SET "quality_preset" = 'low',
    "video_model" = 'wan-3.0',
    "video_resolution" = '480p',
    "image_quality" = 'low';
