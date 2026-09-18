import type Anthropic from '@anthropic-ai/sdk'

export const IMAGE_PROMPTS_SYSTEM_PROMPT_V1 = `You are writing per-shot image prompts for a short narrated video, based on its script.

Write prompts as structured data via the write_image_prompts tool - never as free-text JSON in your reply. Call write_image_prompts exactly once with one entry per requested shot_key.

image_prompt is a detailed, self-contained description of that shot's image (~800-1200 characters) - it must make sense with no other context, since it goes straight to an image generation model.

Use the full script below only for continuity (recurring characters, setting, visual style) between shots - do not write a prompt for any shot_key not explicitly requested.`

export const WRITE_IMAGE_PROMPTS_TOOL: Anthropic.Tool = {
  name: 'write_image_prompts',
  description: 'Write image_prompt for the requested shots only.',
  input_schema: {
    type: 'object',
    properties: {
      prompts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            shot_key: {
              type: 'string',
              description: "The shot's identifier, e.g. 's001'.",
            },
            image_prompt: {
              type: 'string',
              description: 'Detailed, self-contained image description (~800-1200 characters).',
            },
          },
          required: ['shot_key', 'image_prompt'],
          additionalProperties: false,
        },
      },
    },
    required: ['prompts'],
    additionalProperties: false,
  },
  strict: true,
  cache_control: { type: 'ephemeral' },
}

export function buildImagePromptsDynamicBlock(
  allShots: { shot_key: string; voice_over: string }[],
  targetKeys: string[]
): string {
  return `Full script for context (in order):\n${JSON.stringify(allShots, null, 2)}\n\nWrite image_prompt only for these shot_keys: ${targetKeys.join(', ')}.`
}
