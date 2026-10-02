-- Settled model spend per user per UTC calendar month - the rail's dollar figure.
-- "Settled" = status succeeded or failed, exactly aggregateUsage's settledTotal; pending
-- reservations are excluded, and blocked calls settle at 0 so they never move it.
-- security_invoker: the caller's usage RLS (user_id = auth.uid()) applies; anon gets nothing.
create view public.usage_monthly_spend
with (security_invoker = true) as
select
  user_id,
  date_trunc('month', created_at, 'UTC') as month,
  coalesce(sum(estimated_cost) filter (where status in ('succeeded', 'failed')), 0) as settled_cost
from public.usage
group by user_id, date_trunc('month', created_at, 'UTC');

revoke all on public.usage_monthly_spend from anon;
revoke all on public.usage_monthly_spend from authenticated;
grant select on public.usage_monthly_spend to authenticated;
