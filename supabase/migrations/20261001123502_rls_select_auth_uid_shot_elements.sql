-- public.shot_elements: every policy's auth.uid() wrapped as (select auth.uid()), so Postgres
-- evaluates it once per statement as an initPlan instead of once per row. Same policy
-- names, commands, roles and predicates - ALTER POLICY changes only the expressions,
-- copied from pg_policies with that one substitution.

alter policy "users manage shot_elements in their own projects" on public.shot_elements
  using ((EXISTS ( SELECT 1
   FROM (shots
     JOIN projects ON ((projects.id = shots.project_id)))
  WHERE ((shots.id = shot_elements.shot_id) AND (projects.user_id = ( SELECT auth.uid() AS uid))))));
