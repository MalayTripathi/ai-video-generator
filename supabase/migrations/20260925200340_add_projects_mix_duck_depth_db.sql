-- Preview & mix: how far the music is lowered under each spoken word, in dB. Null means
-- the default in src/lib/config/storyboard.ts (MIX_DUCK_DEPTH_DB).
ALTER TABLE "public"."projects"
    ADD COLUMN "mix_duck_depth_db" numeric;
