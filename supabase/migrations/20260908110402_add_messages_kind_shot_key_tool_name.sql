-- Persists tool activity (what the agent did, not just what it said) alongside plain
-- user/assistant prose, and names which shot (if any) and which tool a row is about -
-- both stable across a shot's own renumbering (shot_key, never a display number) and its
-- eventual deletion (deliberately no FK - see below). See docs/decisions.md ("C4
-- persisted tool activity and per-turn cost").

-- `kind` distinguishes plain conversational content from a tool-activity row without
-- overloading `role`, which stays exactly user/assistant, unconstrained, untouched.
-- Every existing row (and every future plain insert, e.g. runShotGeneration's own
-- assistant message) defaults to 'text' with zero code changes required at those sites.
alter table "public"."messages"
    add column "kind" text not null default 'text';

alter table "public"."messages"
    add constraint "messages_kind_check"
    check ("kind" in ('text', 'tool_done', 'refusal'));

-- Deliberately no foreign key: a tool_done/refusal row must still name the shot it was
-- about after that shot is later deleted (the shot's own delete button - C4's agent
-- tools can never delete a shot) - an FK ON DELETE SET NULL would erase exactly the
-- value a reload needs to render "a shot that's since been deleted".
alter table "public"."messages"
    add column "shot_key" text;

-- Only a tool_done row names which of the four dispatchable tools ran - a refusal's
-- reason is free-form prose, never a templated verb+number, so it needs no tool_name.
-- 'finish' is excluded: it never reaches dispatchAgentTool (see tools.ts), so no
-- tool_done row can ever be about it.
alter table "public"."messages"
    add column "tool_name" text;

alter table "public"."messages"
    add constraint "messages_tool_name_check"
    check ("tool_name" in ('get_shot', 'update_shot', 'insert_shot', 'regenerate_all_shots'));
