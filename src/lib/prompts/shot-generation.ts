import type Anthropic from '@anthropic-ai/sdk'
import {
  CLASSIFIABLE_VIDEO_TYPES,
  SHOT_SIZES,
  CAMERA_ANGLES,
  CAMERA_MOVEMENTS,
  ELEMENT_TYPES,
} from '@/lib/config/enums'

// v3 - target shot count is now a hard ceiling, not a soft target: added an
// explicit instruction that the count may never be exceeded. Bump the
// suffix (and this comment) on any content change so usage logs / evals can
// be attributed to a specific wording.
export const SHOT_GENERATION_SYSTEM_PROMPT_V3 = `You are breaking a video brief into a structured shot list for a short narrated video.

Write the shot list as structured data via the write_shots tool - never as free-text JSON in your reply. Call write_shots exactly once.

For each shot, write:
- voice_over: the narration line spoken over this shot (can be empty only if the shot carries character dialogue instead)
- visual_description: what the camera sees, self-contained enough to brief an image generator
- shot_size, camera_angle, camera_movement: your best judgment for how this shot should be framed and moved
- duration_sec: how long the shot needs to breathe given its voice_over/dialogue, in whole seconds
- section_label: a short label (e.g. "Introduction", "Foundation") grouping this shot with its neighbors into the film's sections - reuse the same label across consecutive shots that belong to the same section
- dialogue: spoken lines by name, only when a character speaks on camera - usually empty
- element_names: every character, location, and prop visible or referenced in this shot, each with a type and a short visual description - reuse the exact same name for a recurring element across shots so it resolves to one shared asset instead of a duplicate

Also write:
- title: a short project title (max ~60 characters), in the same language as the source text
- message: one short sentence for the user describing what you created (e.g. "I've created 6 shots detailing the construction of the Taj Mahal.")
- video_type: classify this video as exactly one of narrated_story, explainer, facts_listicle, character_drama, product_ad, trailer - pick the closest match based on the brief and the shots you're writing, even if a video type was already given to you

Write voice_over and dialogue in the project's target language. Give a recurring character, location, or prop the exact same element name every time it appears - this is how the app knows to reuse one image across shots instead of generating a new one per shot.

The target shot count given below is a hard maximum, not a suggestion: if the brief asks for more shots than the target, produce exactly the target count instead - never exceed it. If the brief only has enough material for fewer, write fewer; a shorter, accurate shot list is better than padding to hit the count.`

export function buildWriteShotsTool(targetShots: number): Anthropic.Tool {
  return {
    name: 'write_shots',
    description: 'Write the full shot list, title, and a short status message for the video brief.',
    input_schema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Short project title, max ~60 characters, in the same language as the source text.',
        },
        message: {
          type: 'string',
          description: 'One short sentence describing what was created, shown to the user in the agent panel.',
        },
        video_type: {
          type: 'string',
          description: 'Best-matching classification of this video based on the brief and shots.',
          enum: [...CLASSIFIABLE_VIDEO_TYPES],
        },
        shots: {
          type: 'array',
          description: `Up to ${targetShots} shots - the hard maximum for this video's duration tier. Fewer shots are fine if the brief doesn't need that many; never exceed this count.`,
          minItems: 1,
          maxItems: targetShots,
          items: {
            type: 'object',
            properties: {
              voice_over: { type: 'string', description: 'Narration line spoken over this shot.' },
              visual_description: {
                type: 'string',
                description: "Self-contained description of what the camera sees in this shot.",
              },
              shot_size: {
                type: 'string',
                enum: [...SHOT_SIZES],
              },
              camera_angle: {
                type: 'string',
                enum: [...CAMERA_ANGLES],
              },
              camera_movement: {
                type: 'string',
                enum: [...CAMERA_MOVEMENTS],
              },
              duration_sec: { type: 'number', description: 'Shot duration in whole seconds.' },
              section_label: {
                type: 'string',
                description: 'Section this shot belongs to, e.g. "Introduction". Reuse across adjacent shots in the same section.',
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
                    type: { type: 'string', enum: [...ELEMENT_TYPES] },
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
              'duration_sec',
              'section_label',
              'dialogue',
              'element_names',
            ],
            additionalProperties: false,
          },
        },
      },
      required: ['title', 'message', 'video_type', 'shots'],
      additionalProperties: false,
    },
    strict: true,
    cache_control: { type: 'ephemeral' },
  }
}

export function buildShotsDynamicBlock(
  project: { source_text: string | null; video_type: string | null; language: string | null },
  targetShots: number
) {
  return `Video type: ${project.video_type ?? 'auto'}
Target language: ${project.language ?? 'en'}
Target shot count: up to ${targetShots} shots (hard maximum - do not exceed; fewer is fine)

Brief:
${project.source_text ?? ''}

Write the shot list now.`
}
