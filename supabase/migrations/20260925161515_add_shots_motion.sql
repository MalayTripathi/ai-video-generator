-- A shot's own camera motion for the slideshow and preview (Storyboard motion mode).
-- Null means "follow the film default". Render-only: never read by Step 5 or any camera
-- field. The values mirror MOTIONS in src/lib/config/storyboard.ts by hand.
ALTER TABLE "public"."shots"
    ADD COLUMN "motion" text
    CONSTRAINT "shots_motion_check"
    CHECK ("motion" IN ('push_in', 'pull_out', 'pan_left', 'pan_right', 'pan_up', 'pan_down', 'static'));
