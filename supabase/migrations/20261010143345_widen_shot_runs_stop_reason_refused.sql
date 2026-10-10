-- A run whose outline or chunk the model's safety checks declined ends 'refused', so the
-- Shots tab can say so instead of "cut short". Mirrors ShotRunStopReason (src/lib/shots/runs.ts).
alter table "public"."shot_runs" drop constraint "shot_runs_stop_reason_check";

alter table "public"."shot_runs" add constraint "shot_runs_stop_reason_check"
  check ("stop_reason" is null or "stop_reason" in ('balance', 'error', 'chain_limit', 'stale', 'ceiling', 'refused'));
