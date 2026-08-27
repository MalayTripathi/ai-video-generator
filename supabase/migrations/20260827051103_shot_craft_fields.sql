-- Per-shot craft fields: visual description, dialogue lines (by element),
-- camera framing, section grouping, and override/lock flags that tell
-- later steps whether a value was set by the user (and must not be
-- re-derived) or is still free to regenerate.

ALTER TABLE "public"."shots"
    ADD COLUMN "visual_description" text,
    ADD COLUMN "dialogue" jsonb DEFAULT '[]'::jsonb NOT NULL,
    ADD COLUMN "shot_size" text,
    ADD COLUMN "camera_angle" text,
    ADD COLUMN "camera_movement" text,
    ADD COLUMN "section_label" text,
    ADD COLUMN "camera_overridden" boolean DEFAULT false NOT NULL,
    ADD COLUMN "duration_locked" boolean DEFAULT false NOT NULL;

ALTER TABLE "public"."shots"
    ADD CONSTRAINT "shots_shot_size_check" CHECK ("shot_size" IN ('wide', 'full', 'medium', 'close_up', 'extreme_close_up')),
    ADD CONSTRAINT "shots_camera_angle_check" CHECK ("camera_angle" IN ('eye_level', 'low', 'high', 'over_the_shoulder', 'top_down')),
    ADD CONSTRAINT "shots_camera_movement_check" CHECK ("camera_movement" IN ('static', 'slow_push_in', 'pull_out', 'pan', 'tilt', 'orbit', 'handheld'));
