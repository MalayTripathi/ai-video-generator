-- Per-shot spans of the current voiceover: [{shotId, from, to, text, startSec, endSec}],
-- character range in the read script, the narration as read, and its times in the audio.
-- Small by construction (one entry per shot). Null when there is no current voiceover.
ALTER TABLE "public"."projects"
    ADD COLUMN "voiceover_spans" jsonb;
