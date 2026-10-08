-- public.messages: every policy's auth.uid() wrapped as (select auth.uid()), so Postgres
-- evaluates it once per statement as an initPlan instead of once per row. Same policy
-- names, commands, roles and predicates - ALTER POLICY changes only the expressions,
-- copied from pg_policies with that one substitution.

alter policy "users manage messages in their own projects" on public.messages
  using ((EXISTS ( SELECT 1
   FROM projects
  WHERE ((projects.id = messages.project_id) AND (projects.user_id = ( SELECT auth.uid() AS uid))))));
