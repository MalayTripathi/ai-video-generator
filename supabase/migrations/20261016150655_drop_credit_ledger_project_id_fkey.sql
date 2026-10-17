-- credit_ledger.project_id becomes a plain id: a deleted project's credit history keeps
-- naming it (resolved through deleted_projects), and a late charge for it still lands.
alter table "public"."credit_ledger" drop constraint "credit_ledger_project_id_fkey";
