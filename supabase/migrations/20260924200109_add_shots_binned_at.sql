-- When a shot was removed to the Storyboard's bin; null means it is on the timeline. The
-- row, its image and its film_order are kept, so Restore returns it to its original slot.
ALTER TABLE "public"."shots"
    ADD COLUMN "binned_at" timestamptz;
