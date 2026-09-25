-- The motion of a split shot's second segment. Null means "follow the film default".
-- The values mirror MOTIONS in src/lib/config/storyboard.ts by hand.
ALTER TABLE "public"."shots"
    ADD COLUMN "split_motion" text
    CONSTRAINT "shots_split_motion_check"
    CHECK ("split_motion" IN ('push_in', 'pull_out', 'pan_left', 'pan_right', 'pan_up', 'pan_down', 'static'));
