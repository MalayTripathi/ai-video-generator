-- The voiceover lane's Mute. A new voiceover (generated or aligned) resets it to false.
ALTER TABLE "public"."projects"
    ADD COLUMN "voiceover_muted" boolean DEFAULT false NOT NULL;
