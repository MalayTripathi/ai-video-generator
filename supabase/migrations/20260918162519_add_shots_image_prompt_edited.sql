-- True once a person has hand-edited image_prompt; cleared whenever a regeneration
-- overwrites it. Independent of image_prompt_stale: a prompt can be both (the shot
-- changed under a hand-written prompt). A flag, not a copy of the model's text, so the
-- edit never destroys or duplicates paid output.
ALTER TABLE "public"."shots" ADD COLUMN "image_prompt_edited" boolean DEFAULT false NOT NULL;
