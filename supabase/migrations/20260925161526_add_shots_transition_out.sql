-- The join from this shot to the next in-film shot. Null means "follow the film default".
-- A join inside a spoken word resolves to a cut without this value being touched. The
-- values mirror TRANSITIONS in src/lib/config/storyboard.ts by hand.
ALTER TABLE "public"."shots"
    ADD COLUMN "transition_out" text
    CONSTRAINT "shots_transition_out_check"
    CHECK ("transition_out" IN ('cut', 'dissolve'));
