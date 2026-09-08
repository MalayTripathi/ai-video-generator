import type Anthropic from '@anthropic-ai/sdk'
import { SHOT_SIZES, CAMERA_ANGLES, CAMERA_MOVEMENTS, MODEL_REPORTABLE_CAMERA_ORIGINS } from '@/lib/config/enums'

// v6: a live trial of v5's finish wording never bundled it - the model waited for
// every mutation's result, including the last one, before calling finish alone in its
// own extra response, so the call this tool exists to save was still being paid every
// time (see docs/decisions.md). v5 only ever said bundling was allowed; v6 states it
// as the default whenever the model is confident, so waiting needs a reason rather
// than being the unmarked case. (v5: added finish itself, optionally bundled with the
// final mutating call, instead of always needing a separate reply-only call afterward
// to produce a closing message the UI had already shown as it streamed. Existing
// termination paths - a text-only reply, the iteration cap - are unchanged and still
// apply whenever finish is never called. v4: a content request now defaults to a tool
// call instead of a clarifying question, narrowed to which-shot/which-field ambiguity
// or a destructive best-guess. v3: dialogue speakers are back to bound-characters-only
// - v2 briefly let the agent auto-create/bind a character, reverted: C5's subject and
// unbuilt.) Bump the suffix (and this comment) on any content change, matching
// shot-generation.ts's SHOT_GENERATION_SYSTEM_PROMPT_V4 convention.
export const AGENT_SYSTEM_PROMPT_V6 = `You are an assistant embedded in a video project's shot-list workbench. The user will describe a change in plain language; you read the project's shots and make the change yourself by calling tools - you never ask the user to make the edit themselves.

You have five tools:
- get_shot: read full detail for one shot, including which characters are already bound to it (its valid dialogue speakers).
- update_shot: overwrite one or more of an existing shot's own fields, including its dialogue.
- insert_shot: add a new shot at a position.
- regenerate_all_shots: throw away every shot and generate a fresh list from the original brief. This is destructive and expensive - only use it when the user clearly wants to start over, not for editing individual shots.
- finish: call this with your closing message once the user's entire request is complete. It writes nothing - it only ends the turn and delivers your message. See the note on it below.

You are given a compact index of the current shot list below. Use get_shot when you need a shot's full text or its bound characters before editing it.

Default to acting, not asking. When the user asks for content to be written or changed, write it - do not reply with a clarifying question about what the content should say. You already have what you need: the shot's own fields, the elements bound to it, and get_shot on other shots in the project as a style reference - match their voice, length, and level of detail rather than asking the user to specify a style. A written attempt the user doesn't like costs them one turn to redirect; a question that could have been an edit costs a turn and delivers nothing.

Only ask a clarifying question when the request is genuinely ambiguous about WHICH shot or WHICH field to change, or when your best guess at the action would be destructive or hard to undo. Never ask just because you'd have to make a creative judgment call about wording, tone, or detail - making that call is what you're for.

Hard rules, never bend these regardless of how the user phrases a request:
- There is no delete tool, and none of your tools can delete a shot. If the user asks you to delete or remove a shot, tell them to use that shot's own delete button in the UI - do not attempt to "empty out" or blank a shot's fields as a substitute for deleting it.
- update_shot only writes the fields you explicitly include in the call. Never include a field you don't intend to change.
- A camera field (shot_size, camera_angle, camera_movement) already marked as a manual override in the shot index is protected - only include it in your call if the user is explicitly asking you to change that specific framing choice.
- update_shot's dialogue field replaces a shot's ENTIRE line list, not one line - always include every line you want to keep, not just the ones you're changing. Every speaker_name must already be a character bound to that shot (see get_shot) - you cannot introduce a new speaker or create a character; if the user wants a character who isn't bound to this shot to speak, say so rather than guessing.
- If a tool refuses your request (a locked project, a regeneration you're not allowed to run, an unbound dialogue speaker), explain why in plain language in your reply - do not silently drop the request or pretend it succeeded.

When the user's entire request is done, call finish with a short, plain-language summary of what you changed (or why you couldn't) instead of just replying with text. Default to calling finish in the SAME response as your final tool call, not a separate one afterward: if you're confident that action will succeed, you already know the outcome, so don't spend a whole extra call just to say so - only wait for the result first when you're genuinely not sure it will succeed. But it must only ever accompany the LAST action the request needs: a request naming several shots is not finished after the first one, and finish must never accompany a call whose outcome you still need to see before deciding what to do next. If more tool calls are still needed, don't call finish yet.`

export type ShotIndexRow = {
  order_index: number
  visual_description: string | null
  voice_over: string
  shot_size_origin: string
  camera_angle_origin: string
  camera_movement_origin: string
}

const SLUG_MAX_LENGTH = 50

const OVERRIDE_FIELD_LABELS: { origin: keyof ShotIndexRow; label: string }[] = [
  { origin: 'shot_size_origin', label: 'shot_size' },
  { origin: 'camera_angle_origin', label: 'camera_angle' },
  { origin: 'camera_movement_origin', label: 'camera_movement' },
]

// Marks a voice_over-fallback slug so the agent can see "no visual description yet" directly
// from the index, instead of spending a get_shot call to discover it - this is the gap that
// caused the agent to ask a clarifying question instead of writing one for shot 1.
const NO_VISUAL_DESCRIPTION_SUFFIX = ' (no visual description)'

function buildSlug(shot: ShotIndexRow): string {
  const hasVisualDescription = Boolean(shot.visual_description && shot.visual_description.trim())
  const source = hasVisualDescription ? shot.visual_description! : shot.voice_over || ''
  const trimmed = source.trim() || '(empty shot)'
  const truncated = trimmed.length > SLUG_MAX_LENGTH ? `${trimmed.slice(0, SLUG_MAX_LENGTH)}…` : trimmed
  return !hasVisualDescription && truncated !== '(empty shot)' ? `${truncated}${NO_VISUAL_DESCRIPTION_SUFFIX}` : truncated
}

/**
 * A compact, plain-text shot index - cheaper per-token than JSON, and numbers shots
 * 1-based from order_index to match the UI's own "Shot {order_index + 1}" convention
 * (shot-card.tsx), so the model reasons in the same numbering a user would type ("change
 * shot 3"). Deliberately excludes full shot bodies - get_shot is for detail. Target is
 * well under 2000 tokens for a typical project; at ~15-20 tokens/line this comfortably
 * covers a 75-shot project.
 */
export function buildShotIndexBlock(shots: ShotIndexRow[]): string {
  return shots
    .map((shot) => {
      const overridden = OVERRIDE_FIELD_LABELS.filter(({ origin }) => shot[origin] === 'override').map(
        ({ label }) => label
      )
      const suffix = overridden.length > 0 ? ` [override: ${overridden.join(', ')}]` : ''
      return `${shot.order_index + 1}. ${buildSlug(shot)}${suffix}`
    })
    .join('\n')
}

const CAMERA_FIELD_PROPERTIES = {
  shot_size: { type: 'string' as const, enum: [...SHOT_SIZES] },
  shot_size_origin: { type: 'string' as const, enum: [...MODEL_REPORTABLE_CAMERA_ORIGINS] },
  camera_angle: { type: 'string' as const, enum: [...CAMERA_ANGLES] },
  camera_angle_origin: { type: 'string' as const, enum: [...MODEL_REPORTABLE_CAMERA_ORIGINS] },
  camera_movement: { type: 'string' as const, enum: [...CAMERA_MOVEMENTS] },
  camera_movement_origin: { type: 'string' as const, enum: [...MODEL_REPORTABLE_CAMERA_ORIGINS] },
}

const GET_SHOT_TOOL: Anthropic.Tool = {
  name: 'get_shot',
  description:
    "Fetch full detail for one shot by its number in the current shot index, including which characters are already bound to it (its existing dialogue speakers).",
  input_schema: {
    type: 'object',
    properties: {
      // No `minimum` here - the tool-use API rejects numeric JSON Schema constraints
      // (400 on 'integer' + 'minimum'). The >= 1 check lives in loadShotByNumber
      // (agent/tools.ts) instead.
      shot_number: { type: 'integer', description: '1-based shot number, as shown in the shot index.' },
    },
    required: ['shot_number'],
    additionalProperties: false,
  },
  strict: true,
}

const UPDATE_SHOT_TOOL: Anthropic.Tool = {
  name: 'update_shot',
  description:
    "Overwrite one or more of a shot's own fields, including its dialogue lines. Only fields explicitly included in this call are written - never include a field you don't intend to change. dialogue, when included, REPLACES that shot's entire dialogue list - include every line you want to keep, not just the changed ones. Every speaker_name must already be a character bound to this shot (see get_shot) - this cannot introduce a new speaker.",
  input_schema: {
    type: 'object',
    properties: {
      // No `minimum` - see get_shot's comment above; enforced in handleUpdateShot instead.
      shot_number: { type: 'integer' },
      voice_over: { type: 'string' },
      visual_description: { type: 'string' },
      duration_sec: { type: 'number' },
      section_label: { type: 'string' },
      ...CAMERA_FIELD_PROPERTIES,
      dialogue: {
        type: 'array',
        description: "Replaces this shot's entire dialogue list. Pass [] to clear all lines.",
        items: {
          type: 'object',
          properties: {
            speaker_name: { type: 'string', description: 'Must match a character already bound to this shot.' },
            line: { type: 'string' },
          },
          required: ['speaker_name', 'line'],
          additionalProperties: false,
        },
      },
    },
    required: ['shot_number'],
    additionalProperties: false,
  },
  strict: true,
}

const INSERT_SHOT_TOOL: Anthropic.Tool = {
  name: 'insert_shot',
  description:
    'Insert a new shot into the list. Position is relative to an existing shot number, never a raw index - the server places it and renumbers everything after it.',
  input_schema: {
    type: 'object',
    properties: {
      // No `minimum` - see get_shot's comment above; enforced in handleInsertShot instead.
      insert_after_shot_number: {
        type: 'integer',
        description: '0 to insert as the new first shot; otherwise the shot number this new shot follows.',
      },
      voice_over: { type: 'string' },
      visual_description: { type: 'string' },
      duration_sec: { type: 'number' },
      section_label: { type: 'string' },
      ...CAMERA_FIELD_PROPERTIES,
    },
    required: ['insert_after_shot_number', 'voice_over'],
    additionalProperties: false,
  },
  strict: true,
}

const REGENERATE_ALL_SHOTS_TOOL: Anthropic.Tool = {
  name: 'regenerate_all_shots',
  description:
    'Re-runs full shot generation from the original brief, replacing every shot. Only permitted before any work has been done past the workbench step.',
  input_schema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  strict: true,
}

// Ends the turn explicitly, optionally bundled with the model's final mutating call in
// the same response - see logic.ts's iteration loop for how a bundled call is verified
// (not trusted blindly) before its message is used, and docs/decisions.md for why the
// savings this enables are a model-behaviour bet, not a guarantee. Never routed through
// dispatchAgentTool - it has no handler and mutates nothing.
const FINISH_TOOL: Anthropic.Tool = {
  name: 'finish',
  description:
    "Call this with a short closing message once the user's ENTIRE request is complete - never after only one step of a multi-part request. Writes nothing; it only ends the turn and delivers your message. Default to calling it in the SAME response as your final tool call, not a later one - if you're confident that action will succeed, you already know the outcome, and waiting for its result before finishing just spends a whole extra call to say what you already knew. Only wait when you're genuinely unsure the final action will succeed. But it must only ever accompany the LAST action the request needs: if a request names several shots, or otherwise still needs more tool calls, finish is not appropriate yet - keep going and only call it once nothing else is left to do.",
  input_schema: {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        description: 'Short, plain-language summary of what you changed (or why you could not) - same content as your normal closing reply.',
      },
    },
    required: ['message'],
    additionalProperties: false,
  },
  strict: true,
  // Large/stable, reused unchanged across every iteration of a turn's loop - the last
  // tool in the array carries the breakpoint, matching buildWriteShotsTool's convention.
  cache_control: { type: 'ephemeral' },
}

export const AGENT_TOOLS: Anthropic.Tool[] = [
  GET_SHOT_TOOL,
  UPDATE_SHOT_TOOL,
  INSERT_SHOT_TOOL,
  REGENERATE_ALL_SHOTS_TOOL,
  FINISH_TOOL,
]
