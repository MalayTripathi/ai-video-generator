-- credit_ledger_monthly gains `actions`: how many user actions a group's rows stand for. A
-- held action (shot generation) writes a hold and at most one settle - a refund, or one extra
-- spend for an excess - so `entries` would count an excess as a second action. `actions`
-- counts every row except a settle (dedupe_key 'settle:{hold id}', src/lib/credits/ledger.ts).
-- Appended last, so `create or replace` keeps the existing columns and their consumers.
create or replace view public.credit_ledger_monthly
with (security_invoker = true) as
select
  user_id,
  date_trunc('month', created_at, 'UTC') as month,
  kind,
  step,
  operation,
  project_id,
  sum(delta)::bigint as credits,
  count(*)::bigint as entries,
  count(*) filter (where dedupe_key not like 'settle:%')::bigint as actions
from public.credit_ledger
group by user_id, date_trunc('month', created_at, 'UTC'), kind, step, operation, project_id;

revoke all on public.credit_ledger_monthly from anon;
revoke all on public.credit_ledger_monthly from authenticated;
grant select on public.credit_ledger_monthly to authenticated;
