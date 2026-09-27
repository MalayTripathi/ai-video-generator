-- One active export per project: a second request while one is queued or rendering
-- fails this index (23505), which the route returns as 409. Load-bearing - it is the
-- export lock, the way generations_identity_idx is the generation lock.
CREATE UNIQUE INDEX "exports_one_active_idx" ON "public"."exports" USING btree ("project_id")
    WHERE "status" IN ('queued', 'rendering');
