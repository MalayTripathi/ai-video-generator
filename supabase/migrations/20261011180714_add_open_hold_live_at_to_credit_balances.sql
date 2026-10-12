-- credit_balances gains open_hold_live_at: the earliest "last known alive" time across the
-- user's open holds, so the one balance read the sidebar, /credits, intake and every credit
-- check already make also says whether a dead run's hold needs releasing - no second query
-- on the normal path.
--
-- A hold is a 'spend' row whose dedupe_key is 'hold:{n}' (src/lib/credits/ledger.ts). It is
-- open while no 'settle:{hold id}' row exists and its shot run (shot_runs.attempt_id, unique)
-- is still uncharged; a settle that wrote nothing (actual = hold) is closed by the run's
-- charged_at. An open hold's liveness is its run's latest heartbeat or finish, or the hold's
-- own created_at when it has no run. Null when the user has no open hold.
--
-- No interval lives here: the application compares this value with its stale window
-- (SHOT_RUN_STALE_AFTER_MS), so the window has one source. Columns are appended, so
-- `create or replace` keeps the existing ones and their consumers unchanged.
create or replace view public.credit_balances
with (security_invoker = true) as
select
  l.user_id,
  sum(l.delta)::bigint as balance,
  count(*)::bigint as entries,
  min(
    case
      when l.kind <> 'spend' or l.dedupe_key not like 'hold:%' then null
      when exists (
        select 1 from public.credit_ledger s
        where s.user_id = l.user_id and s.dedupe_key = 'settle:' || l.id::text
      ) then null
      when not exists (select 1 from public.shot_runs r where r.attempt_id = l.attempt_id) then l.created_at
      else (
        select greatest(r.heartbeat_at, r.finished_at)
        from public.shot_runs r
        where r.attempt_id = l.attempt_id and r.charged_at is null
      )
    end
  ) as open_hold_live_at
from public.credit_ledger l
group by l.user_id;

revoke all on public.credit_balances from anon;
revoke all on public.credit_balances from authenticated;
grant select on public.credit_balances to authenticated;
