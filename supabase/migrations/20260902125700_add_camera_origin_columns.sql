-- Replace the single shots.camera_overridden boolean with three independent
-- origin columns, one per camera field. A two-state boolean can't express
-- "the visual description named this choice" (derived) separately from
-- "the AI chose it freely" (auto) or "a person set it manually" (override).

alter table "public"."shots"
    add column "shot_size_origin" text not null default 'auto',
    add column "camera_angle_origin" text not null default 'auto',
    add column "camera_movement_origin" text not null default 'auto';

alter table "public"."shots"
    add constraint "shots_shot_size_origin_check" check ("shot_size_origin" in ('auto', 'derived', 'override')),
    add constraint "shots_camera_angle_origin_check" check ("camera_angle_origin" in ('auto', 'derived', 'override')),
    add constraint "shots_camera_movement_origin_check" check ("camera_movement_origin" in ('auto', 'derived', 'override'));

-- Backfill: every column already defaults to 'auto', so only the true case
-- needs an explicit UPDATE.
--
-- Nothing backfills to 'derived'. Determining which existing shots have a
-- camera term in their visual description would require a paid Claude call
-- per shot for a purely cosmetic result. Existing shots read as 'auto' and
-- become accurate the first time they're re-derived.
update "public"."shots"
set
    "shot_size_origin" = 'override',
    "camera_angle_origin" = 'override',
    "camera_movement_origin" = 'override'
where "camera_overridden" = true;

alter table "public"."shots"
    drop column "camera_overridden";
