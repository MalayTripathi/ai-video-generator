-- storage.objects: every policy's auth.uid() wrapped as (select auth.uid()), so Postgres
-- evaluates it once per statement as an initPlan instead of once per row. Same policy
-- names, commands, roles and predicates - ALTER POLICY changes only the expressions,
-- copied from pg_policies with that one substitution.

alter policy "users can delete own artifacts" on storage.objects
  using (((bucket_id = 'artifacts'::text) AND ((storage.foldername(name))[1] = (( SELECT auth.uid() AS uid))::text)));

alter policy "users can read own artifacts" on storage.objects
  using (((bucket_id = 'artifacts'::text) AND ((storage.foldername(name))[1] = (( SELECT auth.uid() AS uid))::text)));

alter policy "users can upload own artifacts" on storage.objects
  with check (((bucket_id = 'artifacts'::text) AND ((storage.foldername(name))[1] = (( SELECT auth.uid() AS uid))::text)));
