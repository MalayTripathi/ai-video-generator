import type Anthropic from '@anthropic-ai/sdk'

// v2 - added video_type classification. Bump the suffix (and this comment)
// on any content change so usage logs / evals can be attributed to a
// specific wording.
export const SHOT_GENERATION_SYSTEM_PROMPT_V2 = `You are breaking a video brief into a structured shot list for a short narrated video.

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

Write voice_over and dialogue in the project's target language. Give a recurring character, location, or prop the exact same element name every time it appears - this is how the app knows to reuse one image across shots instead of generating a new one per shot.`

export const WRITE_SHOTS_TOOL: Anthropic.Tool = {
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
        enum: [
          'narrated_story',
          'explainer',
          'facts_listicle',
          'character_drama',
          'product_ad',
          'trailer',
        ],
      },
      shots: {
        type: 'array',
        minItems: 1,
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
              enum: ['wide', 'full', 'medium', 'close_up', 'extreme_close_up'],
            },
            camera_angle: {
              type: 'string',
              enum: ['eye_level', 'low', 'high', 'over_the_shoulder', 'top_down'],
            },
            camera_movement: {
              type: 'string',
              enum: ['static', 'slow_push_in', 'pull_out', 'pan', 'tilt', 'orbit', 'handheld'],
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
                  type: { type: 'string', enum: ['character', 'location', 'prop'] },
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

export function buildShotsDynamicBlock(
  project: { source_text: string | null; video_type: string | null; language: string | null },
  targetShots: number
) {
  return `Video type: ${project.video_type ?? 'auto'}
Target language: ${project.language ?? 'en'}
Target shot count: about ${targetShots} shots

Brief:
${project.source_text ?? ''}

Write the shot list now.`
}
