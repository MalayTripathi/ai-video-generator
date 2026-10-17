-- Deleting an element no longer silently deletes its generations rows: a reference-image
-- claim that starts while cleanup deletes the element makes the delete fail (23503) instead
-- of losing the claim. NO ACTION, not RESTRICT - it is checked at statement end, so a project
-- delete that cascades elements and generations together still succeeds.
alter table "public"."generations" drop constraint "generations_element_id_fkey";

alter table "public"."generations"
    add constraint "generations_element_id_fkey"
    foreign key ("element_id") references "public"."elements"("id");
