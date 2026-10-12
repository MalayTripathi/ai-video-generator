-- A chunk row that closes a scene without a request asks for no shots: allow max_shots = 0.
alter table "public"."shot_run_chunks" drop constraint "shot_run_chunks_max_shots_check";
alter table "public"."shot_run_chunks" add constraint "shot_run_chunks_max_shots_check" check ("max_shots" >= 0);
