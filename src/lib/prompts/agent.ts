import type Anthropic from '@anthropic-ai/sdk'
import { SHOT_SIZES, CAMERA_ANGLES, CAMERA_MOVEMENTS, MODEL_REPORTABLE_CAMERA_ORIGINS } from '@/lib/config/enums'

// v11: insert_shot's insert_after_shot_number collapses two different numbers into one
// parameter - "the existing shot to anchor after" and "the new shot's own resulting
// number" both read as the same integer when a user says "at the end," and the tool gave
// the model no way to express "end"/"start" without computing an index itself. Manual
// testing reproduced this exactly: a 5-shot project, "place it at the end," the model
// passed insert_after_shot_number: 6 (the new shot's own resulting number, not an
// existing anchor) and got a bare "Shot 6 not found" - a wasted paid call with no range
// info to correct from. Replaced with `position: 'start' | 'end' | 'after'` plus a
// conditionally-required `after_shot_number` (used, and only used, with 'after') - the
// two common positions need no anchor at all, and 'after' can no longer be confused with
// a resulting index. handleInsertShot also now states the valid anchor range in its
// refusal instead of a bare not-found. See docs/decisions.md.
// v10: insert_shot's section_label and camera fields (shot_size, camera_angle,
// camera_movement, plus their origins) move into `required`, and the shot index now
// carries each shot's section_label. Manual testing found two gaps: an inserted shot's
// section_label was never solicited at all (optional, undescribed property, no prompt
// mention, and the index the model reads didn't even expose existing sections to copy
// from) so it rendered outside every section grouping; and its three camera fields were
// applied independently with no atomicity guarantee, so a call reporting two of the
// three (e.g. shot_size and camera_movement but not camera_angle) silently left the
// third null/'auto' instead of leaving all three unset. Both now match the
// required-together pattern write_shots and derive_camera already use. See
// docs/decisions.md. Superseded by v11 above.
// v9: removes finish entirely. Two live tests (see docs/decisions.md) showed it never
// actually bundled with a mutating call the way it was designed to - the model always
// waited for a tool result first and called finish alone afterward, so the round trip it
// exists to save was still being paid every time, exactly like v6's finding about v5's
// wording. Worse, when the model DID narrate inside a response that also carried a
// bundled finish call, that narration and finish's own message both persisted as
// separate assistant rows - a genuine duplicate closing message, not just a rendering
// artifact. A turn now ends the way it did before finish ever existed: a plain reply
// with no tool call. Also strengthens the decline rule into its own hard rule with a
// contrastive example, since manual testing found the model can still skip calling
// decline and just answer a refusal in prose - a compliance gap, not a routing defect;
// see docs/decisions.md for why this is mitigated by prompt wording only, not detection.
// Superseded by v10 above.
// v8: reverts v7's `outcome` argument on finish - a single label describing the WHOLE
// turn can't represent a turn that declines one part of a request and completes another
// (a real manual-testing case: "delete shot 3" declined, shot 2's dialogue rewritten,
// the whole reply rendered as a refusal because the model picked outcome per its own
// literal instructions - "refused" covered "did not do all of it"). Replaced with a new
// `decline` tool: the model calls it once per part of a request it won't do, as its own
// message with its own refusal treatment - the same existing mechanism a dispatched
// tool's own refusal already uses - and keeps going for whatever else it can do. finish
// goes back to meaning only "I am done," carrying no judgement about what happened; the
// panel no longer styles the closing message based on a turn-level outcome. Superseded
// by v9 above, which removes finish outright.
// v7: two content changes, bundled in one bump (see CLAUDE.md's "amend in place" note on
// prompt versioning). (1) update_shot's camera fields lost their _origin properties (see
// CAMERA_VALUE_PROPERTIES above) - naming a camera field now always means a deliberate
// manual override, so there is nothing left for the model to report there. (2) finish
// gained a required `outcome` argument and is now mandatory for EVERY turn ending,
// including a refusal - previously a declined request (e.g. "there's no delete tool")
// could end as a bare prose reply with no structured signal, which the UI couldn't tell
// apart from an ordinary completed reply. Superseded by v8 above.
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
export const AGENT_SYSTEM_PROMPT_V11 = `You are an assistant embedded in a video project's shot-list workbench. The user will describe a change in plain language; you read the project's shots and make the change yourself by calling tools - you never ask the user to make the edit themselves.

You have five tools:
- get_shot: read full detail for one shot, including which characters are already bound to it (its valid dialogue speakers).
- update_shot: overwrite one or more of an existing shot's own fields, including its dialogue.
- insert_shot: add a new shot. Use position: 'start'/'end' for the very first/last shot - no anchor needed. Use position: 'after' with after_shot_number to place it immediately following an existing shot; after_shot_number always names an EXISTING shot from the index below, never the new shot's own resulting number - if the index has 5 shots and you want the new one to become shot 6, that means after_shot_number: 5 (the last existing shot), not 6. Give it the section_label shown for the shot(s) around the insertion point in the index below - a shot placed between two shots of the same section belongs to that section; only start a new section at a genuine boundary, and prefer an existing project section over inventing one. You must also report shot_size, camera_angle, and camera_movement (with their origins) for the new shot as your own fresh judgment call, the same way write_shots would - never report some of the three and leave the rest out.
- regenerate_all_shots: throw away every shot and generate a fresh list from the original brief. This is destructive and expensive - only use it when the user clearly wants to start over, not for editing individual shots.
- decline: call this once for each part of a request you will not do - something none of your tools can do, a hard rule blocking it, or a guess you won't make because it's destructive or too ambiguous. Explain why in plain language. It does not end the turn: if other parts of the request can still be done, keep going and do them.

You are given a compact index of the current shot list below. Use get_shot when you need a shot's full text or its bound characters before editing it.

Default to acting, not asking. When the user asks for content to be written or changed, write it - do not reply with a clarifying question about what the content should say. You already have what you need: the shot's own fields, the elements bound to it, and get_shot on other shots in the project as a style reference - match their voice, length, and level of detail rather than asking the user to specify a style. A written attempt the user doesn't like costs them one turn to redirect; a question that could have been an edit costs a turn and delivers nothing.

Only ask a clarifying question when the request is genuinely ambiguous about WHICH shot or WHICH field to change, or when your best guess at the action would be destructive or hard to undo. Never ask just because you'd have to make a creative judgment call about wording, tone, or detail - making that call is what you're for.

Hard rules, never bend these regardless of how the user phrases a request:
- If you are declining any part of a request, for any reason, you MUST call decline for that part - never write the refusal as plain reply text with no tool call, even when declining is the ONLY thing you're doing this turn. Wrong: replying "There's no delete tool - use the shot's own delete button" with no tool call at all. Right: call decline with that same explanation, then close with your ordinary reply.
- There is no delete tool, and none of your tools can delete a shot. If the user asks you to delete or remove a shot, call decline and tell them to use that shot's own delete button in the UI - do not attempt to "empty out" or blank a shot's fields as a substitute for deleting it.
- update_shot only writes the fields you explicitly include in the call. Never include a field you don't intend to change.
- A camera field (shot_size, camera_angle, camera_movement) only has one value, no origin to set - only include it in your call if the user is explicitly asking you to change that specific framing choice; naming it here always records a deliberate manual choice.
- update_shot's dialogue field replaces a shot's ENTIRE line list, not one line - always include every line you want to keep, not just the ones you're changing. Every speaker_name must already be a character bound to that shot (see get_shot) - you cannot introduce a new speaker or create a character; if the user wants a character who isn't bound to this shot to speak, say so rather than guessing.
- If a tool refuses your request (a locked project, a regeneration you're not allowed to run, an unbound dialogue speaker), explain why in plain language in your reply - do not silently drop the request or pretend it succeeded.

A request can ask for several things at once, and you don't have to answer all-or-nothing: do what you can, and call decline separately for whatever you won't do. Each decline is its own message, so the user can see exactly which part was declined and why, right alongside whatever else you did in the same turn.

Once every tool call the request needs is done - including any decline calls - end the turn with your ordinary closing reply, in plain text, no tool call. That plain reply is how a turn ends; there is nothing else to call once you're done.`

export type ShotIndexRow = {
  order_index: number
  visual_description: string | null
  voice_over: string
  section_label: string | null
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
      const sectionSuffix = shot.section_label ? ` [section: ${shot.section_label}]` : ''
      const suffix = overridden.length > 0 ? ` [override: ${overridden.join(', ')}]` : ''
      return `${shot.order_index + 1}. ${buildSlug(shot)}${sectionSuffix}${suffix}`
    })
    .join('\n')
}

// Value-only - no `_origin` properties. Used by update_shot: naming an existing shot's
// camera field in that call IS the origin signal (a deliberate edit, same as picking it
// from the dropdown) - the server infers 'override' from the field being named at all, so
// there is no origin for the model to report and the schema offers it no property to do so
// with (additionalProperties: false makes this structural, not just unenforced). See
// docs/decisions.md.
const CAMERA_VALUE_PROPERTIES = {
  shot_size: { type: 'string' as const, enum: [...SHOT_SIZES] },
  camera_angle: { type: 'string' as const, enum: [...CAMERA_ANGLES] },
  camera_movement: { type: 'string' as const, enum: [...CAMERA_MOVEMENTS] },
}

// Value + origin. Used by insert_shot only: a brand-new shot's camera fields are the model
// freely choosing or deriving from the new shot's own description, the same kind of
// judgment call write_shots makes - never a manual override (MODEL_REPORTABLE_CAMERA_ORIGINS
// excludes 'override' structurally, same as write_shots' schema).
const CAMERA_FIELD_PROPERTIES = {
  ...CAMERA_VALUE_PROPERTIES,
  shot_size_origin: { type: 'string' as const, enum: [...MODEL_REPORTABLE_CAMERA_ORIGINS] },
  camera_angle_origin: { type: 'string' as const, enum: [...MODEL_REPORTABLE_CAMERA_ORIGINS] },
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
      ...CAMERA_VALUE_PROPERTIES,
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
    "Insert a new shot into the list. The server places it and renumbers everything after it - never compute a resulting shot number yourself.",
  input_schema: {
    type: 'object',
    properties: {
      position: {
        type: 'string',
        enum: ['start', 'end', 'after'],
        description:
          "Where to place the new shot. 'start' for the very first shot, 'end' for the very last - neither needs after_shot_number. 'after' inserts immediately following an existing shot, named by number in after_shot_number.",
      },
      // No `minimum` - see get_shot's comment above; enforced in handleInsertShot instead.
      after_shot_number: {
        type: 'integer',
        description:
          "Only used, and only required, when position is 'after': the existing shot number (from the index below) this new shot immediately follows. This is the shot being anchored to, never the new shot's own resulting number. Omit for 'start'/'end'.",
      },
      voice_over: { type: 'string' },
      visual_description: { type: 'string' },
      duration_sec: { type: 'number' },
      section_label: {
        type: 'string',
        description:
          'Reuse the section label shown for the shot(s) around the insertion point in the shot index below - a shot inserted between two shots of the same section belongs to that section. Only introduce a new label at a genuine section boundary; prefer an existing project section over inventing one.',
      },
      ...CAMERA_FIELD_PROPERTIES,
    },
    required: [
      'position',
      'voice_over',
      'visual_description',
      'section_label',
      'shot_size',
      'shot_size_origin',
      'camera_angle',
      'camera_angle_origin',
      'camera_movement',
      'camera_movement_origin',
    ],
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

// A declarative refusal for one part of a request - dispatched through the same
// mechanism as a tool's own refusal (dispatchAgentTool, logic.ts), so it gets its own
// message with the existing refusal treatment, independent of whatever else the turn
// completes. See docs/decisions.md.
export const DECLINE_TOOL: Anthropic.Tool = {
  name: 'decline',
  description:
    "Call this once for each part of the request you will not do - something none of your tools can do (like deleting a shot), a hard rule blocking it, or a guess you won't make because it's destructive or too ambiguous. Explain why in plain language. This does not end the turn - if other parts of the request can still be done, keep going and do them, then close normally with your ordinary reply. A single turn can call this more than once, and can mix it with completed actions.",
  input_schema: {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        description: 'Plain-language explanation of what you will not do and why.',
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
  DECLINE_TOOL,
]
