-- The current voiceover's spoken-word boundaries, as [start, end] pairs in seconds -
-- computed once when a read settles, from its alignment's characters split on spaces, so
-- the Storyboard's forced-cut rule never reads the alignment file. Null with no voiceover.
ALTER TABLE "public"."projects"
    ADD COLUMN "voiceover_words" jsonb;
