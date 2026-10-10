-- True when a shot's narration is longer than the project video model's longest shot can
-- hold even after the split rule: its duration was clamped at the maximum.
alter table "public"."shots"
    add column "narration_overflow" boolean not null default false;
