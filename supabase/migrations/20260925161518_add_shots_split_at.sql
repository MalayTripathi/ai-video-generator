-- Where a shot's one split falls, as a fraction of its length, so retiming never breaks
-- it. Null means no split. Render-only: every later step still sees one shot.
ALTER TABLE "public"."shots"
    ADD COLUMN "split_at" numeric
    CONSTRAINT "shots_split_at_check"
    CHECK ("split_at" > 0 AND "split_at" < 1);
