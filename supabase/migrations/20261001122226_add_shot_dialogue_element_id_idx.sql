-- Serves the elements read's shot_dialogue(count) embed (src/lib/elements/read.ts), which
-- counts through shot_dialogue.element_id, and that foreign key's cascade.
create index shot_dialogue_element_id_idx on public.shot_dialogue (element_id);
