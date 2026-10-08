-- Preview & mix: the music bed's gain, in dB. Null means the default in
-- src/lib/config/storyboard.ts (MIX_MUSIC_GAIN_DB).
ALTER TABLE "public"."projects"
    ADD COLUMN "mix_music_gain_db" numeric;
