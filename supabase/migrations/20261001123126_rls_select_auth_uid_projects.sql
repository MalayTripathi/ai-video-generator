-- public.projects: every policy's auth.uid() wrapped as (select auth.uid()), so Postgres
-- evaluates it once per statement as an initPlan instead of once per row. Same policy
-- names, commands, roles and predicates - ALTER POLICY changes only the expressions,
-- copied from pg_policies with that one substitution.

alter policy "users can delete their own projects" on public.projects
  using ((( SELECT auth.uid() AS uid) = user_id));

alter policy "users can insert their own projects" on public.projects
  with check ((( SELECT auth.uid() AS uid) = user_id));

alter policy "users can update their own projects" on public.projects
  using ((( SELECT auth.uid() AS uid) = user_id));

alter policy "users can view their own projects" on public.projects
  using ((( SELECT auth.uid() AS uid) = user_id));
