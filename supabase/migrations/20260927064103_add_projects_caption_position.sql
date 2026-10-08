-- Export settings: where burned-in captions sit. Null means the storyboard.ts default.
-- Mirrors CAPTION_POSITIONS in src/lib/config/enums.ts by hand.
ALTER TABLE "public"."projects"
    ADD COLUMN "caption_position" text
    CONSTRAINT "projects_caption_position_check"
    CHECK ("caption_position" IN ('bottom', 'middle'));
