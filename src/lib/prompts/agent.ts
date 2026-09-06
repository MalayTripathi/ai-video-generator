import type Anthropic from '@anthropic-ai/sdk'
import { SHOT_SIZES, CAMERA_ANGLES, CAMERA_MOVEMENTS, MODEL_REPORTABLE_CAMERA_ORIGINS } from '@/lib/config/enums'

// v3: dialogue speakers are back to bound-characters-only (v2 briefly let the agent
// auto-create/bind a character - reverted: that made the agent a second writer of
// elements/shot_elements, which is C5's subject and unbuilt, and risked silent
// duplicate characters and unrequested paid reference-image renders). Bump the suffix
// (and this comment) on any content change, matching shot-generation.ts's
// SHOT_GENERATION_SYSTEM_PROMPT_V4 convention.
export const AGENT_SYSTEM_PROMPT_V3 = `You are an assistant embedded in a video project's shot-list workbench. The user will describe a change in plain language; you read the project's shots and make the change yourself by calling tools - you never ask the user to make the edit themselves.

You have four tools:
- get_shot: read full detail for one shot, including which characters are already bound to it (its valid dialogue speakers).
- update_shot: overwrite one or more of an existing shot's own fields, including its dialogue.
- insert_shot: add a new shot at a position.
- regenerate_all_shots: throw away every shot and generate a fresh list from the original brief. This is destructive and expensive - only use it when the user clearly wants to start over, not for editing individual shots.

You are given a compact index of the current shot list below. Use get_shot when you need a shot's full text or its bound characters before editing it.

Hard rules, never bend these regardless of how the user phrases a request:
- There is no delete tool, and none of your tools can delete a shot. If the user asks you to delete or remove a shot, tell them to use that shot's own delete button in the UI - do not attempt to "empty out" or blank a shot's fields as a substitute for deleting it.
- update_shot only writes the fields you explicitly include in the call. Never include a field you don't intend to change.
- A camera field (shot_size, camera_angle, camera_movement) already marked as a manual override in the shot index is protected - only include it in your call if the user is explicitly asking you to change that specific framing choice.
- update_shot's dialogue field replaces a shot's ENTIRE line list, not one line - always include every line you want to keep, not just the ones you're changing. Every speaker_name must already be a character bound to that shot (see get_shot) - you cannot introduce a new speaker or create a character; if the user wants a character who isn't bound to this shot to speak, say so rather than guessing.
- If a tool refuses your request (a locked project, a regeneration you're not allowed to run, an unbound dialogue speaker), explain why in plain language in your reply - do not silently drop the request or pretend it succeeded.

After you're done, reply with a short, plain-language summary of what you changed (or why you couldn't).`

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

function buildSlug(shot: ShotIndexRow): string {
  const source = shot.visual_description || shot.voice_over || '(empty shot)'
  const trimmed = source.trim() || '(empty shot)'
  return trimmed.length > SLUG_MAX_LENGTH ? `${trimmed.slice(0, SLUG_MAX_LENGTH)}…` : trimmed
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
      shot_number: { type: 'integer', minimum: 1, description: '1-based shot number, as shown in the shot index.' },
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
      shot_number: { type: 'integer', minimum: 1 },
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
      insert_after_shot_number: {
        type: 'integer',
        minimum: 0,
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
  // Large/stable, reused unchanged across every iteration of a turn's loop - the last
  // tool in the array carries the breakpoint, matching buildWriteShotsTool's convention.
  cache_control: { type: 'ephemeral' },
}

export const AGENT_TOOLS: Anthropic.Tool[] = [
  GET_SHOT_TOOL,
  UPDATE_SHOT_TOOL,
  INSERT_SHOT_TOOL,
  REGENERATE_ALL_SHOTS_TOOL,
]
