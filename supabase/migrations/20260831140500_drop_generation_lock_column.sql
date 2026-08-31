-- Phase 1 prompt 3: /prompts converges onto the generations claim
-- (src/lib/generations/claim.ts), the same mechanism /shots already uses. The old
-- generating_at-only CAS lock (src/lib/generation-lock.ts, now deleted) was the last
-- reader of this column - drop it now that the lock is gone.
ALTER TABLE "public"."projects"
    DROP COLUMN "generating_at";
