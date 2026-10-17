-- Replaced storage files whose delete waits for a project's export to finish (the worker
-- downloads its inputs at render start). The export worker removes a project's paths when
-- its export ends; deleting the project cascades the rows and its storage sweep removes the
-- files. Service-role only: RLS on, no policies.
create table "public"."pending_storage_deletions" (
    "id" uuid primary key default gen_random_uuid(),
    "project_id" uuid not null references "public"."projects"("id") on delete cascade,
    "user_id" uuid not null,
    "path" text not null,
    "created_at" timestamptz not null default now(),
    constraint "pending_storage_deletions_path_key" unique ("path")
);

create index "pending_storage_deletions_project_id_idx" on "public"."pending_storage_deletions" using btree ("project_id");

alter table "public"."pending_storage_deletions" enable row level security;

revoke all on "public"."pending_storage_deletions" from anon;
revoke all on "public"."pending_storage_deletions" from authenticated;
