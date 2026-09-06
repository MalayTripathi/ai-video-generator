-- Client-minted idempotency key for the user's turn: the browser mints a uuid when the
-- user presses send, and the insert of the user message is the idempotency claim - a
-- 23505 on this constraint means this exact message was already accepted. Nullable
-- because existing rows have none and Postgres permits multiple NULLs under a UNIQUE
-- constraint, so no backfill is needed. See docs/decisions.md for why this exists
-- alongside the generations mutex (concurrency vs. sequential-retry duplication).

alter table "public"."messages"
    add column "client_id" uuid;

alter table "public"."messages"
    add constraint "messages_project_id_client_id_key" unique ("project_id", "client_id");
