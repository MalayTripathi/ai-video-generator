import type Anthropic from '@anthropic-ai/sdk'
import { CLASSIFIABLE_VIDEO_TYPES } from '@/lib/config/enums'

// v1 - the first call of shot generation: plans the film as ordered scenes with their
// lengths, before any shot is written. Bump the suffix (and this comment) on any content
// change so usage logs / evals can be attributed to a specific wording.
export const SHOT_OUTLINE_SYSTEM_PROMPT_V1 = `You are planning a short narrated video from a brief, as an ordered list of scenes. Another step writes each scene's shots afterwards, from your plan.

Write the plan as structured data via the write_outline tool - never as free-text JSON in your reply. Call write_outline exactly once.

For each scene, in film order, write:
- title: a short scene title (e.g. "The Storm"), in the project's target language
- summary: two or three sentences on what happens and what the narration covers in this scene - enough for a writer who has not read the brief to write its shots
- location: where the scene takes place
- time_of_day: when it takes place (e.g. "dusk"), or "unspecified"
- element_names: the names of every recurring character, location, and prop that appears in the scene - use the exact same name for the same element in every scene
- seconds: how long the scene runs, in whole seconds

The scenes' seconds must add up to the target length given below. Use as many scenes as the story needs - a scene is a continuous stretch in one place and time, or one beat of an explainer.

Also write:
- title: a short project title (max ~60 characters), in the same language as the source text
- message: one short sentence for the user describing the video you planned (e.g. "I've planned a short film about the construction of the Taj Mahal.")
- video_type: classify this video as exactly one of narrated_story, explainer, facts_listicle, character_drama, product_ad, trailer - pick the closest match based on the brief, even if a video type was already given to you
- style: if the brief suggests a consistent visual look (e.g. "clean lines, soft colors, historical details, educational tone"), write it once for the whole video as a short name plus a keyword description. Leave this empty if no clear house style applies.`

export const WRITE_OUTLINE_TOOL: Anthropic.Tool = {
  name: 'write_outline',
  description: 'Write the ordered scene plan, title, and a short status message for the video brief.',
  input_schema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Short project title, max ~60 characters, in the same language as the source text.',
      },
      message: {
        type: 'string',
        description: 'One short sentence describing what was planned, shown to the user in the agent panel.',
      },
      video_type: {
        type: 'string',
        description: 'Best-matching classification of this video based on the brief.',
        enum: [...CLASSIFIABLE_VIDEO_TYPES],
      },
      scenes: {
        type: 'array',
        description: 'The scenes in film order. Their seconds add up to the target length.',
        minItems: 1,
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            summary: { type: 'string' },
            location: { type: 'string' },
            time_of_day: { type: 'string' },
            element_names: {
              type: 'array',
              description: 'Recurring characters, locations and props in this scene, by exact name.',
              items: { type: 'string' },
            },
            seconds: { type: 'number', description: 'Scene length in whole seconds.' },
          },
          required: ['title', 'summary', 'location', 'time_of_day', 'element_names', 'seconds'],
          additionalProperties: false,
        },
      },
      style: {
        type: 'array',
        description:
          'At most one project-wide visual style: a short name plus a keyword description, applied to every shot\'s image prompt. Empty if no clear house style applies. Never more than one - only the first is used.',
        minItems: 0,
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            description: { type: 'string' },
          },
          required: ['name', 'description'],
          additionalProperties: false,
        },
      },
    },
    required: ['title', 'message', 'video_type', 'scenes', 'style'],
    additionalProperties: false,
  },
  strict: true,
  cache_control: { type: 'ephemeral' },
}

export function buildOutlineDynamicBlock(
  project: { source_text: string | null; video_type: string | null; language: string | null },
  targetSeconds: number
): string {
  return `Video type: ${project.video_type ?? 'auto'}
Target language: ${project.language ?? 'en'}
Target length: ${targetSeconds} seconds - the scenes' seconds add up to this

Brief:
${project.source_text ?? ''}

Plan the scenes now.`
}
