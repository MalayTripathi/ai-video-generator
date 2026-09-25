-- Preview & mix: the voiceover's gain, in dB. Null means the default in
-- src/lib/config/storyboard.ts (MIX_VOICE_GAIN_DB); the range is enforced by the save action.
ALTER TABLE "public"."projects"
    ADD COLUMN "mix_voice_gain_db" numeric;
