-- Serves the workbench's dialogue read (project_id = X) and shot_dialogue's RLS policy,
-- which is keyed on the denormalized project_id. The only index was (shot_id, order_index).
create index shot_dialogue_project_id_idx on public.shot_dialogue (project_id);
