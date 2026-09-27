-- Export settings: captions off, as an .srt file, burned in, or both. Null means the
-- storyboard.ts default. Mirrors CAPTION_MODES in src/lib/config/enums.ts by hand.
ALTER TABLE "public"."projects"
    ADD COLUMN "caption_mode" text
    CONSTRAINT "projects_caption_mode_check"
    CHECK ("caption_mode" IN ('off', 'srt', 'burned', 'both'));
