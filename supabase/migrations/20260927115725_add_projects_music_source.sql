-- Where the current music came from. Mirrors MUSIC_SOURCES in src/lib/config/enums.ts by hand.
ALTER TABLE "public"."projects"
    ADD COLUMN "music_source" text,
    ADD CONSTRAINT "projects_music_source_check"
        CHECK ("music_source" IS NULL OR "music_source" IN ('generated', 'uploaded'));
