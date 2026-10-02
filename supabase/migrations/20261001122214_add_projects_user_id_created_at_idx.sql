-- Serves every per-user projects read: the dashboard list and /projects/new's recent list
-- (user_id = X ORDER BY created_at DESC), the projects RLS predicate (user_id = auth.uid()),
-- and the projects!inner(user_id) joins (live-claim and committed-credit reads). There was
-- no index on projects.user_id at all.
create index projects_user_id_created_at_idx on public.projects (user_id, created_at desc);
