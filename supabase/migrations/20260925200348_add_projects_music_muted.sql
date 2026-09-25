-- The music lane's mute, beside voiceover_muted. Null means unmuted. Read by the film
-- timeline now; the Music lane that sets it arrives with Storyboard D.
ALTER TABLE "public"."projects"
    ADD COLUMN "music_muted" boolean;
