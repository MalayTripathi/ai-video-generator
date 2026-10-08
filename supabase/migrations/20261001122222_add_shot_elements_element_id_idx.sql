-- Serves the elements read's shot_elements(count) embed (src/lib/elements/read.ts), which
-- counts through shot_elements.element_id, and the ON DELETE CASCADE from elements. The
-- (shot_id, element_id) primary key can't serve a lookup by element_id alone.
create index shot_elements_element_id_idx on public.shot_elements (element_id);
