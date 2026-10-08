-- Storage path of the current voiceover's character alignment
-- ({user}/{project}/voiceover/{attemptId}.alignment.json). Null when there is no current
-- voiceover. The audio itself is projects.audio_path.
ALTER TABLE "public"."projects"
    ADD COLUMN "voiceover_alignment_path" text;
