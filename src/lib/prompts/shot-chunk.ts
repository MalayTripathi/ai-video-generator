import type Anthropic from '@anthropic-ai/sdk'
import {
  SHOT_SIZES,
  CAMERA_ANGLES,
  CAMERA_MOVEMENTS,
  SHOT_ELEMENT_TYPES,
  MODEL_REPORTABLE_CAMERA_ORIGINS,
} from '@/lib/config/enums'

// v4 - shot generation's chunk call: writes one shot per slot for the next slots of one
// planned scene, continuing from the shot before it (v2: a scene word budget; v3: the budget
// a target, not a wall; v4: code-owned slots - each shot has a length and a word cap for its
// narration and dialogue together, and the model writes exactly one shot per slot. Lengths
// are code's, so the model no longer reports one). Bump the suffix (and this comment) on any
// content change so usage logs / evals can be attributed.
export const SHOT_CHUNK_SYSTEM_PROMPT_V4 = `You are writing the shots for one scene of a short narrated video, from a scene plan.

Write the shots as structured data via the write_shots tool - never as free-text JSON in your reply. Call write_shots exactly once.

Each request lists the shot slots to fill, in order. Write exactly one shot per slot, in slot order. Each slot has a fixed length and a word cap: the narration and dialogue of that shot together must not exceed its cap. A shot with no narration and no dialogue is fine - it holds for its slot's length.

For each shot, write:
- voice_over: the narration line spoken over this shot (can be empty only if the shot carries character dialogue instead, or is silent)
- visual_description: what the camera sees, self-contained enough to brief an image generator — never leave this empty
- shot_size, camera_angle, camera_movement: your best judgment for how this shot should be framed and moved
- shot_size_origin, camera_angle_origin, camera_movement_origin: report 'derived' when and only when visual_description explicitly names that camera choice (e.g. "wide shot" names shot_size); otherwise report 'auto'
- dialogue: spoken lines by name, only when a character speaks on camera - usually empty
- element_names: every character, location, and prop visible or referenced in this shot, each with a type and a short visual description - use the exact names from the scene plan for recurring elements, so they resolve to one shared asset instead of a duplicate

Write voice_over and dialogue in the project's target language. Continue the story from the shot before this one, without repeating it.

Set scene_complete to true when you wrote a shot for every slot asked for.`

export function buildChunkWriteShotsTool(slotCount: number): Anthropic.Tool {
  return {
    name: 'write_shots',
    description: 'Write one shot per slot asked for, in slot order.',
    input_schema: {
      type: 'object',
      properties: {
        shots: {
          type: 'array',
          description: `Exactly ${slotCount} shots, one per slot, in slot order.`,
          // No `maxItems` - the tool-use API only supports `minItems` of 0 or 1. The count is
          // a request, never a save limit: every complete shot returned is kept.
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              voice_over: { type: 'string', description: 'Narration line spoken over this shot.' },
              visual_description: {
                type: 'string',
                description: 'Self-contained description of what the camera sees in this shot.',
              },
              shot_size: { type: 'string', enum: [...SHOT_SIZES] },
              camera_angle: { type: 'string', enum: [...CAMERA_ANGLES] },
              camera_movement: { type: 'string', enum: [...CAMERA_MOVEMENTS] },
              shot_size_origin: {
                type: 'string',
                description: "'derived' only when visual_description explicitly names this shot size; otherwise 'auto'.",
                enum: [...MODEL_REPORTABLE_CAMERA_ORIGINS],
              },
              camera_angle_origin: {
                type: 'string',
                description: "'derived' only when visual_description explicitly names this camera angle; otherwise 'auto'.",
                enum: [...MODEL_REPORTABLE_CAMERA_ORIGINS],
              },
              camera_movement_origin: {
                type: 'string',
                description: "'derived' only when visual_description explicitly names this camera movement; otherwise 'auto'.",
                enum: [...MODEL_REPORTABLE_CAMERA_ORIGINS],
              },
              dialogue: {
                type: 'array',
                description: 'Spoken lines by character name. Usually empty.',
                items: {
                  type: 'object',
                  properties: {
                    speaker_name: { type: 'string' },
                    line: { type: 'string' },
                  },
                  required: ['speaker_name', 'line'],
                  additionalProperties: false,
                },
              },
              element_names: {
                type: 'array',
                description: 'Every character, location, and prop in this shot. Reuse exact names for recurring elements.',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    type: { type: 'string', enum: [...SHOT_ELEMENT_TYPES] },
                    description: { type: 'string' },
                  },
                  required: ['name', 'type', 'description'],
                  additionalProperties: false,
                },
              },
            },
            required: [
              'voice_over',
              'visual_description',
              'shot_size',
              'camera_angle',
              'camera_movement',
              'shot_size_origin',
              'camera_angle_origin',
              'camera_movement_origin',
              'dialogue',
              'element_names',
            ],
            additionalProperties: false,
          },
        },
        scene_complete: {
          type: 'boolean',
          description: 'True when you wrote a shot for every slot asked for.',
        },
      },
      required: ['shots', 'scene_complete'],
      additionalProperties: false,
    },
    strict: true,
    cache_control: { type: 'ephemeral' },
  }
}

export type OutlineSceneForPrompt = { position: number; title: string; summary: string | null; target_seconds: number | null }

/**
 * The project-level context every chunk of a run shares - the brief and the whole plan -
 * as its own system block, so it can be cached across the run's chunks.
 */
export function buildChunkProjectBlock(
  project: { source_text: string | null; video_type: string | null; language: string | null },
  scenes: readonly OutlineSceneForPrompt[]
): string {
  const plan = scenes
    .map((s) => `${s.position + 1}. ${s.title}${s.target_seconds ? ` (${s.target_seconds}s)` : ''}: ${s.summary ?? ''}`)
    .join('\n')
  return `Video type: ${project.video_type ?? 'auto'}
Target language: ${project.language ?? 'en'}

Brief:
${project.source_text ?? ''}

Scene plan:
${plan}`
}

export type PreviousShotForPrompt = { voice_over: string; visual_description: string | null }

export type ChunkSlotForPrompt = { seconds: number; wordCap: number }

export function buildChunkUserMessage(params: {
  scene: {
    position: number
    title: string
    summary: string | null
    location: string | null
    time_of_day: string | null
    target_seconds: number | null
  }
  elementNames: readonly string[]
  previousShot: PreviousShotForPrompt | null
  /** The slots this request fills, in order. */
  slots: readonly ChunkSlotForPrompt[]
  /** The first of them, counted from 1 within the scene, and the scene's slot count. */
  firstSlot: number
  sceneSlots: number
}): string {
  const { scene, slots, firstSlot } = params
  const previous = params.previousShot
    ? `Shot before this one:
Narration: ${params.previousShot.voice_over || '(none)'}
Visual: ${params.previousShot.visual_description ?? '(none)'}`
    : 'This is the first shot of the film.'
  const slotLines = slots
    .map((slot, i) => `${firstSlot + i}. ${slot.seconds}s - at most ${slot.wordCap} words of narration and dialogue together`)
    .join('\n')
  const last = firstSlot + slots.length - 1
  return `Scene ${scene.position + 1}: ${scene.title}
Summary: ${scene.summary ?? ''}
Location: ${scene.location ?? 'unspecified'}
Time of day: ${scene.time_of_day ?? 'unspecified'}
Recurring elements in this scene: ${params.elementNames.length > 0 ? params.elementNames.join(', ') : 'none named'}

Shot slots ${firstSlot}-${last} of this scene's ${params.sceneSlots}${last === params.sceneSlots ? ' - these finish the scene' : ''}:
${slotLines}

${previous}

Write exactly ${slots.length} shots for this scene now, one per slot, continuing from the shot before.`
}
