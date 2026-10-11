import type Anthropic from '@anthropic-ai/sdk'
import {
  SHOT_SIZES,
  CAMERA_ANGLES,
  CAMERA_MOVEMENTS,
  SHOT_ELEMENT_TYPES,
  MODEL_REPORTABLE_CAMERA_ORIGINS,
} from '@/lib/config/enums'

// v2 - shot generation's chunk call: writes up to N shots of one planned scene, continuing
// from the shot before it, within the scene's word budget (v2: the budget replaced "pace
// the scene to its planned length" and the per-shot word allowance). Durations are computed
// in code from the words spoken, so a spoken shot's duration_sec is ignored; only a silent
// shot's is used. Bump the suffix (and this comment) on any content change so usage logs /
// evals can be attributed.
export const SHOT_CHUNK_SYSTEM_PROMPT_V2 = `You are writing the shots for one scene of a short narrated video, from a scene plan.

Write the shots as structured data via the write_shots tool - never as free-text JSON in your reply. Call write_shots exactly once.

For each shot, write:
- voice_over: the narration line spoken over this shot (can be empty only if the shot carries character dialogue instead)
- visual_description: what the camera sees, self-contained enough to brief an image generator — never leave this empty
- shot_size, camera_angle, camera_movement: your best judgment for how this shot should be framed and moved
- shot_size_origin, camera_angle_origin, camera_movement_origin: report 'derived' when and only when visual_description explicitly names that camera choice (e.g. "wide shot" names shot_size); otherwise report 'auto'
- duration_sec: only for a shot with no narration and no dialogue - how long it should hold, in whole seconds. A spoken shot's length is set from its words, so any value works there.
- dialogue: spoken lines by name, only when a character speaks on camera - usually empty
- element_names: every character, location, and prop visible or referenced in this shot, each with a type and a short visual description - use the exact names from the scene plan for recurring elements, so they resolve to one shared asset instead of a duplicate

Write voice_over and dialogue in the project's target language. Each request gives this scene's narration budget in words: keep the narration and dialogue of all the shots you write within it - a shot's length is set by its spoken words, and shots past the budget are not kept. Continue the story from the shot before this one, without repeating it.

Set scene_complete to true when the shots you wrote finish this scene, or false when the scene needs more shots than you were allowed to write - the next request continues it from your last shot.`

export function buildChunkWriteShotsTool(maxShots: number): Anthropic.Tool {
  return {
    name: 'write_shots',
    description: 'Write the next shots of this scene, and whether they finish it.',
    input_schema: {
      type: 'object',
      properties: {
        shots: {
          type: 'array',
          description: `At most ${maxShots} shots for this scene. Fewer is fine.`,
          // No `maxItems` - the tool-use API only supports `minItems` of 0 or 1; the count
          // is enforced in code, which saves only the allowed shots and logs the rest.
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
              duration_sec: {
                type: 'number',
                description: 'Whole seconds a silent shot (no narration, no dialogue) should hold.',
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
              'duration_sec',
              'dialogue',
              'element_names',
            ],
            additionalProperties: false,
          },
        },
        scene_complete: {
          type: 'boolean',
          description: 'True when these shots finish the scene; false when it needs more shots.',
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
  /** Seconds of this scene's reservation not yet written. */
  secondsLeft: number
  /** Spoken words those seconds hold (chunkWordBudget). */
  wordBudget: number
  maxShots: number
}): string {
  const { scene } = params
  const previous = params.previousShot
    ? `Shot before this one:
Narration: ${params.previousShot.voice_over || '(none)'}
Visual: ${params.previousShot.visual_description ?? '(none)'}`
    : 'This is the first shot of the film.'
  return `Scene ${scene.position + 1}: ${scene.title}
Summary: ${scene.summary ?? ''}
Location: ${scene.location ?? 'unspecified'}
Time of day: ${scene.time_of_day ?? 'unspecified'}
Recurring elements in this scene: ${params.elementNames.length > 0 ? params.elementNames.join(', ') : 'none named'}
Narration budget for the rest of this scene: about ${params.wordBudget} words in total, across every shot (about ${Math.round(params.secondsLeft)} seconds of film). Shots past it are not kept.

${previous}

Write at most ${params.maxShots} shots for this scene now, continuing from the shot before.`
}
