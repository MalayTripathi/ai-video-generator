-- 'no_progress': a chain run that saved no shot ends the chain (the progress guard that
-- replaced the fixed chain limit). 'incomplete': a run that ended with an outline scene
-- unwritten or incomplete - never 'completed'. 'chain_limit' stays for past rows.
-- Mirrors ShotRunStopReason (src/lib/shots/runs.ts).
alter table "public"."shot_runs" drop constraint "shot_runs_stop_reason_check";

alter table "public"."shot_runs" add constraint "shot_runs_stop_reason_check"
  check ("stop_reason" is null or "stop_reason" in ('balance', 'error', 'chain_limit', 'stale', 'ceiling', 'refused', 'no_progress', 'incomplete'));
