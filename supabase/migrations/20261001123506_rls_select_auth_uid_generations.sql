-- public.generations: every policy's auth.uid() wrapped as (select auth.uid()), so Postgres
-- evaluates it once per statement as an initPlan instead of once per row. Same policy
-- names, commands, roles and predicates - ALTER POLICY changes only the expressions,
-- copied from pg_policies with that one substitution.

alter policy "users can insert generations in their own projects" on public.generations
  with check ((EXISTS ( SELECT 1
   FROM projects
  WHERE ((projects.id = generations.project_id) AND (projects.user_id = ( SELECT auth.uid() AS uid))))));

alter policy "users can update generations in their own projects" on public.generations
  using ((EXISTS ( SELECT 1
   FROM projects
  WHERE ((projects.id = generations.project_id) AND (projects.user_id = ( SELECT auth.uid() AS uid))))))
  with check ((EXISTS ( SELECT 1
   FROM projects
  WHERE ((projects.id = generations.project_id) AND (projects.user_id = ( SELECT auth.uid() AS uid))))));

alter policy "users can view generations in their own projects" on public.generations
  using ((EXISTS ( SELECT 1
   FROM projects
  WHERE ((projects.id = generations.project_id) AND (projects.user_id = ( SELECT auth.uid() AS uid))))));
