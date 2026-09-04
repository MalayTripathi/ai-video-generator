-- Move character dialogue off the shared shots.dialogue jsonb column onto its
-- own table. A jsonb array can't support independent per-row saves without a
-- read-modify-write race: the C3 UI saves each dialogue row independently,
-- and C4's agent mutation tools will write dialogue concurrently with the UI.
--
-- project_id is denormalised deliberately so RLS and cleanup can scope
-- without a join, matching the pattern already used elsewhere in this repo.

create table "public"."shot_dialogue" (
    "id" uuid primary key default gen_random_uuid(),
    "shot_id" uuid not null references "public"."shots"("id") on delete cascade,
    "project_id" uuid not null references "public"."projects"("id") on delete cascade,
    "element_id" uuid not null references "public"."elements"("id") on delete cascade,
    "line" text not null,
    "order_index" integer not null,
    "created_at" timestamptz not null default now()
);

alter table "public"."shot_dialogue" enable row level security;

-- Single blanket policy, mirroring shots's own shape exactly (one USING
-- clause covering every command) rather than the split SELECT/INSERT/UPDATE
-- pattern used by generations/usage - project_id is denormalised here the
-- same way it is on usage, but shot_dialogue has no orphan-survival need for
-- a split policy the way usage does.
create policy "users manage shot_dialogue in their own projects" on "public"."shot_dialogue"
    using (exists (
        select 1 from "public"."projects"
        where "projects"."id" = "shot_dialogue"."project_id" and "projects"."user_id" = auth.uid()
    ));

create index "shot_dialogue_shot_id_order_index_idx" on "public"."shot_dialogue" using btree ("shot_id", "order_index");

-- Migrate existing data before dropping the old column. shots.dialogue is
-- jsonb NOT NULL DEFAULT '[]', shape {element_id, line}[] - jsonb_array_elements
-- WITH ORDINALITY preserves the array's order into order_index.
insert into "public"."shot_dialogue" ("shot_id", "project_id", "element_id", "line", "order_index")
select
    s.id,
    s.project_id,
    (line_elem->>'element_id')::uuid,
    line_elem->>'line',
    (ordinality - 1)::integer
from "public"."shots" s, jsonb_array_elements(s.dialogue) with ordinality as t(line_elem, ordinality)
where jsonb_array_length(s.dialogue) > 0;

alter table "public"."shots"
    drop column "dialogue";
