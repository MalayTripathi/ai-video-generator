// The messages.kind vocabulary - a third axis distinct from enums.ts (shot attributes/
// project settings) and pipeline.ts (steps/operations/providers). Mirrors
// messages_kind_check (supabase/migrations/20260908110402_add_messages_kind_shot_key_tool_name.sql).
export const MESSAGE_KINDS = ['text', 'tool_done', 'refusal'] as const
export type MessageKind = (typeof MESSAGE_KINDS)[number]

// Mirrors messages_tool_name_check. Deliberately hand-written, not derived from
// AGENT_TOOLS (src/lib/prompts/agent.ts) or AGENT_IMAGE_PROMPTS_TOOLS - both are typed Anthropic.Tool[] with
// name: string, not a literal union, so derivation isn't type-safe there, same reasoning
// as enums.ts's own "never derived from database.types.ts" note. 'decline' is excluded:
// its dispatch result is always 'refused', which persists with toolName: null (logic.ts),
// never 'applied', so it never becomes a tool_name value here. tests/agent-turn.spec.ts's
// AGENT_TOOLS shape test is the human-verified cross-check that this list and AGENT_TOOLS
// stay in step.
export const TOOL_NAMES = [
  'get_shot',
  'update_shot',
  'insert_shot',
  'regenerate_all_shots',
  'regenerate_all_image_prompts',
  'regenerate_image_prompt',
] as const
export type ToolName = (typeof TOOL_NAMES)[number]
