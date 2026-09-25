-- The Storyboard's retimed length for a shot, separate from the script's duration_sec.
-- Null means "use the script length": every Storyboard read uses
-- coalesce(film_duration_sec, duration_sec). The Storyboard never writes duration_sec.
ALTER TABLE "public"."shots"
    ADD COLUMN "film_duration_sec" numeric;
