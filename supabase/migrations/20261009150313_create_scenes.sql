-- Scenes: the outline shot generation plans before it writes shots (Models Task 4). One
-- row per scene, in film order by position. Elements stay bound to shots through
-- shot_elements - there is no scene_elements table. updated_at is set in application
-- code, never by a trigger.
--
-- target_seconds is the outline's planned length for the scene; null for a scene that
-- was not planned by an outline (one migrated from shots.section_label).
create table "public"."scenes" (
    "id" uuid primary key default gen_random_uuid(),
    "project_id" uuid not null references "public"."projects"("id") on delete cascade,
    "position" integer not null,
    "title" text not null,
    "summary" text,
    "location" text,
    "time_of_day" text,
    "target_seconds" integer,
    "created_at" timestamptz not null default now(),
    "updated_at" timestamptz not null default now(),
    constraint "scenes_position_check" check ("position" >= 0),
    constraint "scenes_target_seconds_check" check ("target_seconds" is null or "target_seconds" > 0)
);

create unique index "scenes_project_id_position_idx" on "public"."scenes" using btree ("project_id", "position");

alter table "public"."scenes" enable row level security;

-- Single blanket policy, the same shape as shots's (one USING clause for every command,
-- ownership through the parent project).
create policy "users manage scenes in their own projects" on "public"."scenes"
    using ((exists ( select 1
       from "public"."projects"
      where (("projects"."id" = "scenes"."project_id") and ("projects"."user_id" = ( select auth.uid() as uid))))));
