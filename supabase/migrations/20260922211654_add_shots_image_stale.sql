-- Marks a shot's generated storyboard image as possibly out of date: set by the same
-- edits that set image_prompt_stale (a real prompt-text change, a reference-image change
-- on a bound element, a bind/unbind), cleared only by the write that stores a new image.
-- A flag, never a null - the image the user paid for is kept. Readers check
-- "image_path IS NOT NULL AND image_stale".
ALTER TABLE "public"."shots"
    ADD COLUMN "image_stale" boolean NOT NULL DEFAULT false;
