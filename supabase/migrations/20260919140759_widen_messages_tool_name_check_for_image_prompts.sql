-- Step 3's agent has two dispatchable regeneration tools; a tool_done row for either names
-- its tool, so the allowed set widens to match TOOL_NAMES (src/lib/config/messages.ts).
-- One change: the constraint is dropped and re-added with the longer list, nothing else.
ALTER TABLE "public"."messages" DROP CONSTRAINT "messages_tool_name_check";

ALTER TABLE "public"."messages"
    ADD CONSTRAINT "messages_tool_name_check"
    CHECK ("tool_name" IN (
        'get_shot',
        'update_shot',
        'insert_shot',
        'regenerate_all_shots',
        'regenerate_all_image_prompts',
        'regenerate_image_prompt'
    ));
