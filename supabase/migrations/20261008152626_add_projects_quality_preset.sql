-- Mirrors QUALITY_PRESET_IDS (src/lib/config/enums.ts); 'custom' = settings chosen by hand.
ALTER TABLE "public"."projects"
    ADD COLUMN "quality_preset" "text" NOT NULL DEFAULT 'low',
    ADD CONSTRAINT "projects_quality_preset_check" CHECK ("quality_preset" IN ('low', 'medium', 'high', 'custom'));
