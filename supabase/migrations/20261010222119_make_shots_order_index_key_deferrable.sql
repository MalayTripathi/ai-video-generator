-- Re-sequencing moves many shots in one statement; checked row by row, a shot moving onto
-- an index another still holds is rejected mid-statement. Deferred, uniqueness is checked
-- once at the end of the statement's transaction, so a permutation is one atomic write.
-- No upsert uses this constraint as its conflict target (a deferrable one cannot be).
alter table "public"."shots" drop constraint "shots_project_id_order_index_key";

alter table "public"."shots" add constraint "shots_project_id_order_index_key"
  unique ("project_id", "order_index") deferrable initially deferred;
