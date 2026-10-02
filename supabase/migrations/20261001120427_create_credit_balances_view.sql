-- A user's all-time balance (SUM(delta), computed fresh on every read, never stored) and
-- their ledger row count, so the layout learns "has this user been granted yet" from the
-- same read instead of a separate existence check. security_invoker: the caller's own
-- credit_ledger RLS (user_id = auth.uid()) applies, so a user sees only their own row.
-- A grouped view is not updatable, so it adds no write path; anon gets nothing at all.
create view public.credit_balances
with (security_invoker = true) as
select
  user_id,
  sum(delta)::bigint as balance,
  count(*)::bigint as entries
from public.credit_ledger
group by user_id;

revoke all on public.credit_balances from anon;
revoke all on public.credit_balances from authenticated;
grant select on public.credit_balances to authenticated;
