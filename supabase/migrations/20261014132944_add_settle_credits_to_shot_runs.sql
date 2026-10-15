-- The run's settle record, written in the same update that sets charged_at: the credits held
-- at start, the credits charged, and the credits the platform absorbed (a button run is never
-- charged past its hold). Computed from the run's own record, never from usage. Null until
-- the run is settled; held is null for a run with no hold.
alter table "public"."shot_runs"
    add column "held_credits" integer,
    add column "charged_credits" integer,
    add column "absorbed_credits" integer;
