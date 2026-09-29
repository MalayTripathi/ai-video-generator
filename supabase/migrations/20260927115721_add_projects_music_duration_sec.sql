-- The current music's measured length in seconds (fractional), read server-side.
ALTER TABLE "public"."projects"
    ADD COLUMN "music_duration_sec" numeric;
