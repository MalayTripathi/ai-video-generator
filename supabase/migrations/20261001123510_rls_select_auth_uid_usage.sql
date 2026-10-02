-- public.usage: every policy's auth.uid() wrapped as (select auth.uid()), so Postgres
-- evaluates it once per statement as an initPlan instead of once per row. Same policy
-- names, commands, roles and predicates - ALTER POLICY changes only the expressions,
-- copied from pg_policies with that one substitution.

alter policy "users can insert their own usage" on public.usage
  with check (((user_id = ( SELECT auth.uid() AS uid)) AND ((project_id IS NULL) OR (EXISTS ( SELECT 1
   FROM projects p
  WHERE ((p.id = usage.project_id) AND (p.user_id = ( SELECT auth.uid() AS uid))))))));

alter policy "users can update their own usage" on public.usage
  using ((user_id = ( SELECT auth.uid() AS uid)))
  with check ((user_id = ( SELECT auth.uid() AS uid)));

alter policy "users can view their own usage" on public.usage
  using ((user_id = ( SELECT auth.uid() AS uid)));
