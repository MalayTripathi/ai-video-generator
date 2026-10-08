-- Export settings: the film-wide default transition a null transition_out follows. Null
-- means the storyboard.ts default. Mirrors TRANSITIONS in src/lib/config/enums.ts by hand.
ALTER TABLE "public"."projects"
    ADD COLUMN "export_transition" text
    CONSTRAINT "projects_export_transition_check"
    CHECK ("export_transition" IN ('cut', 'dissolve'));
