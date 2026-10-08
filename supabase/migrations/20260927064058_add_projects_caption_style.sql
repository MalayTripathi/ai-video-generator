-- Export settings: the burned-in caption style preset. Null means the storyboard.ts
-- default. Mirrors CAPTION_STYLES in src/lib/config/enums.ts by hand.
ALTER TABLE "public"."projects"
    ADD COLUMN "caption_style" text
    CONSTRAINT "projects_caption_style_check"
    CHECK ("caption_style" IN ('reelcraft_default'));
