-- When the current voiceover landed (generated or aligned). Null when there is none.
ALTER TABLE "public"."projects"
    ADD COLUMN "voiceover_generated_at" timestamptz;
