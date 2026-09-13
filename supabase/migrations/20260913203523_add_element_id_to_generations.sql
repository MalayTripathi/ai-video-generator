-- generate_element_reference claims are element-scoped, never shot-scoped
-- (shot_id is always null for this operation). Without an element_id column,
-- generations_identity_idx (project_id, step, operation, shot_id) collapses every
-- element in a project onto the same identity row, NULLS NOT DISTINCT making them
-- collide - the second element's claim would be blocked by the first's, or a
-- reclaim from one element's completed row would silently answer a different
-- element's request. Reference generation must support N independent
-- invocations per project (one per element, each with its own claim, charge,
-- and failure) - this column plus the widened index is what makes that true.
ALTER TABLE "public"."generations" ADD COLUMN "element_id" uuid;

ALTER TABLE ONLY "public"."generations"
    ADD CONSTRAINT "generations_element_id_fkey" FOREIGN KEY ("element_id") REFERENCES "public"."elements"("id") ON DELETE CASCADE;

DROP INDEX "public"."generations_identity_idx";

CREATE UNIQUE INDEX "generations_identity_idx" ON "public"."generations" USING btree ("project_id", "step", "operation", "shot_id", "element_id") NULLS NOT DISTINCT;
