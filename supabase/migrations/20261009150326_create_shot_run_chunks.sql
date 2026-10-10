-- One row per chunk of a shot run: one Claude request writing up to max_shots shots of one
-- scene. A table, not a jsonb array on shot_runs, because chunks run in parallel and would
-- race a read-modify-write. payload is the raw tool input, written before any shot row so a
-- dead chunk is replayed rather than paid for twice; cost_usd is the call's settled cost.
-- project_id is denormalised so RLS scopes without a join. updated_at is set in code.
create table "public"."shot_run_chunks" (
    "id" uuid primary key default gen_random_uuid(),
    "run_id" uuid not null references "public"."shot_runs"("id") on delete cascade,
    "project_id" uuid not null references "public"."projects"("id") on delete cascade,
    "scene_id" uuid not null references "public"."scenes"("id") on delete cascade,
    "chunk_index" integer not null,
    "max_shots" integer not null,
    "status" text not null default 'pending',
    "shots_saved" integer not null default 0,
    "cost_usd" numeric not null default 0,
    "payload" jsonb,
    "error" text,
    "started_at" timestamptz,
    "created_at" timestamptz not null default now(),
    "updated_at" timestamptz not null default now(),
    constraint "shot_run_chunks_status_check" check ("status" in ('pending', 'running', 'succeeded', 'failed')),
    constraint "shot_run_chunks_max_shots_check" check ("max_shots" > 0),
    constraint "shot_run_chunks_shots_saved_check" check ("shots_saved" >= 0)
);

create unique index "shot_run_chunks_run_scene_chunk_idx" on "public"."shot_run_chunks" using btree ("run_id", "scene_id", "chunk_index");
create index "shot_run_chunks_project_id_idx" on "public"."shot_run_chunks" using btree ("project_id");
create index "shot_run_chunks_scene_id_idx" on "public"."shot_run_chunks" using btree ("scene_id");

alter table "public"."shot_run_chunks" enable row level security;

create policy "users manage shot_run_chunks in their own projects" on "public"."shot_run_chunks"
    using ((exists ( select 1
       from "public"."projects"
      where (("projects"."id" = "shot_run_chunks"."project_id") and ("projects"."user_id" = ( select auth.uid() as uid))))));
