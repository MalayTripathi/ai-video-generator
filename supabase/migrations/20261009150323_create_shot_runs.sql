-- One row per shot-generation user action (Generate shots, Generate remaining shots, or
-- the agent's regenerate_all_shots), keyed by its attempt id. Bookkeeping for the
-- self-continuing chain only - not the ledger: credit_ledger gets exactly one row per
-- action, written once when charged_at is first set.
--
-- heartbeat_at is re-stamped by every run in the chain; a 'running' row whose heartbeat
-- is older than the stale window belongs to a dead chain. turn_cost_usd / turn_settled_at
-- are the agent turn's own spend, handed over when the turn ends (agent runs only).
-- outline_cost_usd is the outline call's settled cost. updated_at is set in application
-- code.
create table "public"."shot_runs" (
    "id" uuid primary key default gen_random_uuid(),
    "project_id" uuid not null references "public"."projects"("id") on delete cascade,
    "attempt_id" uuid not null,
    "kind" text not null,
    "status" text not null default 'running',
    "stop_reason" text,
    "generation_id" uuid references "public"."generations"("id") on delete set null,
    "message_id" uuid references "public"."messages"("id") on delete set null,
    "agent_generation_id" uuid references "public"."generations"("id") on delete set null,
    "total_scenes" integer,
    "outline_cost_usd" numeric not null default 0,
    "turn_cost_usd" numeric,
    "turn_settled_at" timestamptz,
    "heartbeat_at" timestamptz not null default now(),
    "finished_at" timestamptz,
    "charged_at" timestamptz,
    "created_at" timestamptz not null default now(),
    "updated_at" timestamptz not null default now(),
    constraint "shot_runs_kind_check" check ("kind" in ('generate', 'remaining')),
    constraint "shot_runs_status_check" check ("status" in ('running', 'completed', 'stopped', 'failed')),
    constraint "shot_runs_stop_reason_check" check ("stop_reason" is null or "stop_reason" in ('balance', 'error', 'chain_limit', 'stale', 'ceiling'))
);

create unique index "shot_runs_attempt_id_idx" on "public"."shot_runs" using btree ("attempt_id");
create index "shot_runs_project_id_created_at_idx" on "public"."shot_runs" using btree ("project_id", "created_at");

alter table "public"."shot_runs" enable row level security;

create policy "users manage shot_runs in their own projects" on "public"."shot_runs"
    using ((exists ( select 1
       from "public"."projects"
      where (("projects"."id" = "shot_runs"."project_id") and ("projects"."user_id" = ( select auth.uid() as uid))))));
