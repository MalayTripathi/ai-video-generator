-- Export settings: the loudness target the final mix is normalised to. Null means the
-- storyboard.ts default. Mirrors LOUDNESS_PRESETS in src/lib/config/enums.ts by hand.
ALTER TABLE "public"."projects"
    ADD COLUMN "loudness_preset" text
    CONSTRAINT "projects_loudness_preset_check"
    CHECK ("loudness_preset" IN ('streaming', 'podcast', 'broadcast'));
