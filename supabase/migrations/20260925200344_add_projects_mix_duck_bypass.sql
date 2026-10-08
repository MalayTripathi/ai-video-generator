-- Preview & mix: true turns ducking off. Null means not bypassed.
ALTER TABLE "public"."projects"
    ADD COLUMN "mix_duck_bypass" boolean;
