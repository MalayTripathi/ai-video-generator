-- The current music's storage path (artifacts bucket, [user]/[project]/music/[attemptId].*).
-- Null means no music. Remove nulls it; the file itself is kept.
ALTER TABLE "public"."projects"
    ADD COLUMN "music_path" text;
