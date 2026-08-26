ALTER TABLE "public"."projects"
    ADD COLUMN "furthest_step" smallint DEFAULT 1 NOT NULL;

UPDATE "public"."projects" SET "current_step" = 'workbench' WHERE "current_step" = 'script';
UPDATE "public"."projects" SET "current_step" = 'image_prompts' WHERE "current_step" = 'images';
UPDATE "public"."projects" SET "current_step" = 'generation' WHERE "current_step" = 'video';

UPDATE "public"."projects"
SET "furthest_step" = CASE "current_step"
    WHEN 'intake' THEN 1
    WHEN 'workbench' THEN 2
    WHEN 'voiceover' THEN 3
    WHEN 'image_prompts' THEN 4
    WHEN 'storyboard' THEN 5
    WHEN 'video_prompts' THEN 6
    WHEN 'generation' THEN 7
    WHEN 'assembly' THEN 8
    ELSE 1
END;
