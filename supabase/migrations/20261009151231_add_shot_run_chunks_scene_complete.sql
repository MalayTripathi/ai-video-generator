-- True on the chunk that finished its scene: the model said the scene is complete, or the
-- scene reached its planned seconds or its shot limit. A scene with no such chunk in any
-- run is unwritten - what "Generate remaining shots" picks up.
alter table "public"."shot_run_chunks"
    add column "scene_complete" boolean not null default false;
