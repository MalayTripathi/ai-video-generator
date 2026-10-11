-- How many usable shots the model returned for this chunk; shots_saved is how many were
-- accepted. The difference is output discarded by the scene's reserved seconds, the
-- project's limits or a truncated answer - recorded, not only logged.
alter table "public"."shot_run_chunks"
    add column "shots_returned" integer not null default 0;
