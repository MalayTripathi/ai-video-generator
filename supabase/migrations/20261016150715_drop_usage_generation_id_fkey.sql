-- usage.generation_id becomes a plain id: a cascaded generations delete never edits usage.
alter table "public"."usage" drop constraint "usage_generation_id_fkey";
