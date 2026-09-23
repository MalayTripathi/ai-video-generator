-- The queued marker for claims that wait behind a concurrency pool (storyboard images).
-- Set at claim time, cleared when the worker actually starts the shot (which also
-- re-stamps started_at), so a queued claim is aged against its own, longer window and a
-- started one against the per-call window. Written only by src/lib/generations/claim.ts.
-- NULL for every other operation.
ALTER TABLE "public"."generations"
    ADD COLUMN "queued_at" timestamptz;
