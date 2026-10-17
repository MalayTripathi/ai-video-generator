-- A hold settled at exactly its amount writes no settle row; its run's charged_at closes it.
-- Deleting the project cascades that run away, which made the hold read as "open with no
-- run" and invited a full refund. Project deletion closes every hold first, so a hold whose
-- project is in deleted_projects is never open. Only the no-run branch changes; columns are
-- unchanged, so `create or replace` keeps every consumer.
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
      when not exists (select 1 from public.shot_runs r where r.attempt_id = l.attempt_id) then
        case
          when exists (select 1 from public.deleted_projects d where d.id = l.project_id) then null
          else l.created_at
        end
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
