-- A deleted project's name and shape, keyed by the project's own id, so credit and usage
-- history can still name it. The projects row itself is hard-deleted. No spend figure is
-- stored: spend is always computed live from credit_ledger and usage. storage_purged_at
-- stays null until the project's storage prefix has been swept, so a failed sweep is retried.
-- Writes are service-role only; a user can read their own rows.
create table "public"."deleted_projects" (
    "id" uuid primary key,
    "user_id" uuid not null references "auth"."users"("id") on delete cascade,
    "title" text not null,
    "shot_count" integer not null,
    "duration_tier" text,
    "furthest_step" smallint not null,
    "created_at" timestamptz not null,
    "deleted_at" timestamptz not null default now(),
    "storage_purged_at" timestamptz
);

create index "deleted_projects_unpurged_idx" on "public"."deleted_projects" using btree ("user_id")
    where "storage_purged_at" is null;

alter table "public"."deleted_projects" enable row level security;

create policy "users can view their own deleted projects" on "public"."deleted_projects"
    for select using ("user_id" = ( select auth.uid() as uid));

revoke all on "public"."deleted_projects" from anon;
revoke all on "public"."deleted_projects" from authenticated;
grant select on "public"."deleted_projects" to authenticated;
