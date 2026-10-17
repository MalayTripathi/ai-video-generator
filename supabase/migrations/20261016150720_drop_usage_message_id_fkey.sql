-- usage.message_id becomes a plain id: a cascaded messages delete never edits usage.
alter table "public"."usage" drop constraint "usage_message_id_fkey";
