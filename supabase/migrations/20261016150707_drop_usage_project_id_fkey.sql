-- usage.project_id becomes a plain id, so spend stays attributed to a deleted project.
alter table "public"."usage" drop constraint "usage_project_id_fkey";
