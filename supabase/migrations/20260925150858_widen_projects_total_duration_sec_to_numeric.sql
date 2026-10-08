-- total_duration_sec holds the current voiceover's measured length, which is fractional
-- (a read runs e.g. 34.21s). The column was an integer from the original schema and had
-- no reader or writer, so widening it loses nothing.
ALTER TABLE "public"."projects"
    ALTER COLUMN "total_duration_sec" TYPE numeric;
