-- credit_ledger.message_id becomes a plain id: project deletion removes messages, and a
-- ledger row is never modified by it.
alter table "public"."credit_ledger" drop constraint "credit_ledger_message_id_fkey";
