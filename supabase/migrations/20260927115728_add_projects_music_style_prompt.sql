-- The music style prompt: derived once per project, then the user's to edit.
ALTER TABLE "public"."projects"
    ADD COLUMN "music_style_prompt" text;
