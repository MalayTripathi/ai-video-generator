-- credit_ledger grouped per user, UTC calendar month, kind, step, operation and project -
-- what the rail's month figure and the /credits breakdowns aggregate, done by Postgres
-- instead of shipping every row to JS. `month` is the UTC month start (timestamptz), the
-- same boundary src/app/(app)/usage/period.ts's getPeriodRange computes. Never joins
-- `usage`. security_invoker: the caller's credit_ledger RLS applies; anon gets nothing.
create view public.credit_ledger_monthly
with (security_invoker = true) as
select
  user_id,
  date_trunc('month', created_at, 'UTC') as month,
  kind,
  step,
  operation,
  project_id,
  sum(delta)::bigint as credits,
  count(*)::bigint as entries
from public.credit_ledger
group by user_id, date_trunc('month', created_at, 'UTC'), kind, step, operation, project_id;

revoke all on public.credit_ledger_monthly from anon;
revoke all on public.credit_ledger_monthly from authenticated;
grant select on public.credit_ledger_monthly to authenticated;
