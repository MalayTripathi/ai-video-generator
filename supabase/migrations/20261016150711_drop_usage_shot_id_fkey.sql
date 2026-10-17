-- usage.shot_id becomes a plain id: deleting or regenerating a shot no longer nulls it.
alter table "public"."usage" drop constraint "usage_shot_id_fkey";
