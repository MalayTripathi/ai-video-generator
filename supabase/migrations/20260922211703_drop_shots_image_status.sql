-- Unused since the original schema: storyboard image state is read from the shot's own
-- generations claim row (queued / generating / failed) plus shots.image_path, so a second
-- per-shot status column could only drift from it.
ALTER TABLE "public"."shots" DROP COLUMN "image_status";
