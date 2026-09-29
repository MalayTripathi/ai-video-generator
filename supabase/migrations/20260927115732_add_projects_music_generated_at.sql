-- When the current music was generated or uploaded.
ALTER TABLE "public"."projects"
    ADD COLUMN "music_generated_at" timestamptz;
