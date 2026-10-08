-- Loop to fit: loop the music with a crossfade until the picture ends. Ignored when the
-- music is already at least as long as the picture.
ALTER TABLE "public"."projects"
    ADD COLUMN "music_loop" boolean NOT NULL DEFAULT false;
