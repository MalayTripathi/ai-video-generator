-- The blanket (project_id, client_id) constraint didn't scope to role, so an assistant
-- reply couldn't also carry its triggering turn's client_id for correlation without
-- colliding with the user row that already occupies it. Only a role='user' row's
-- client_id needs to be unique per project - it's the idempotency claim (see
-- messages-idempotency.ts). Scoping the index to that role lets an assistant reply carry
-- the SAME client_id purely as a lookup value (no uniqueness needed on it), so a
-- duplicate resend can fetch "the reply to this exact turn" with one indexed lookup
-- instead of guessing from row order. See docs/decisions.md.
--
-- A partial unique index can't be expressed as a table CONSTRAINT, so this is
-- drop-then-create, not an ALTER ... ADD CONSTRAINT. NULLs stay non-colliding, same as
-- the constraint it replaces.

alter table "public"."messages"
    drop constraint "messages_project_id_client_id_key";

create unique index "messages_user_client_id_idx"
    on "public"."messages" ("project_id", "client_id")
    where role = 'user';
