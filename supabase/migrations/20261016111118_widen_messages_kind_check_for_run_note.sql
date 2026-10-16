-- 'run_note' is the shot chain's own plan note (the outline's message), for agent and button
-- runs alike - so the end-of-run refresh can fetch exactly it. Older notes stay 'text'.
alter table "public"."messages" drop constraint "messages_kind_check";

alter table "public"."messages"
    add constraint "messages_kind_check"
    check ("kind" in ('text', 'tool_done', 'refusal', 'run_note'));
