-- Export settings (Storyboard F): the film-wide default motion a shot with a null motion
-- follows. Null means the storyboard.ts default. Mirrors EXPORT_MOTIONS in
-- src/lib/config/enums.ts by hand.
ALTER TABLE "public"."projects"
    ADD COLUMN "export_motion" text
    CONSTRAINT "projects_export_motion_check"
    CHECK ("export_motion" IN ('alternate', 'push_in', 'pull_out', 'pan_left', 'pan_right', 'pan_up', 'pan_down', 'static'));
