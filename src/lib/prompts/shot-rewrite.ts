import type Anthropic from '@anthropic-ai/sdk'

// v1 - shot generation's per-shot rewrite: one shot whose narration and dialogue together run
// past its slot's word cap, rewritten to fit, with only the context it needs (the scene's
// summary and the shots either side). Never a whole scene. Bump the suffix (and this comment)
// on any content change so usage logs / evals can be attributed.
export const SHOT_REWRITE_SYSTEM_PROMPT_V1 = `You shorten the spoken words of one shot of a short narrated video so they fit the shot's length.

Write the result via the rewrite_shot tool - never as free-text JSON in your reply. Call rewrite_shot exactly once.

The shot's narration and dialogue together must not exceed the word cap given. Keep what the shot says and its place in the story: tighten the wording rather than dropping the point. Keep every dialogue line's speaker, and keep the lines in order. Write in the project's target language. Inline audio tags in square brackets (e.g. [warmly]) are not spoken and do not count as words - keep them where they help.`

export const REWRITE_SHOT_TOOL: Anthropic.Tool = {
  name: 'rewrite_shot',
  description: "Write the shot's shortened narration and dialogue.",
  input_schema: {
    type: 'object',
    properties: {
      voice_over: { type: 'string', description: 'The shortened narration line - empty if the shot had none.' },
      dialogue: {
        type: 'array',
        description: 'The shortened dialogue lines, same speakers in the same order - empty if the shot had none.',
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
    },
    required: ['voice_over', 'dialogue'],
    additionalProperties: false,
  },
  strict: true,
  cache_control: { type: 'ephemeral' },
}

export function buildShotRewriteUserMessage(params: {
  language: string | null
  sceneSummary: string | null
  previousNarration: string | null
  nextNarration: string | null
  voiceOver: string
  dialogue: readonly { speaker_name: string; line: string }[]
  wordCap: number
  words: number
}): string {
  const dialogue =
    params.dialogue.length > 0 ? params.dialogue.map((d) => `${d.speaker_name}: ${d.line}`).join('\n') : '(none)'
  return `Target language: ${params.language ?? 'en'}
Scene summary: ${params.sceneSummary ?? ''}
Narration of the shot before: ${params.previousNarration || '(none)'}
Narration of the shot after: ${params.nextNarration || '(none)'}

The shot - ${params.words} words, its cap is ${params.wordCap}:
Narration: ${params.voiceOver || '(none)'}
Dialogue:
${dialogue}

Rewrite it now, at most ${params.wordCap} words of narration and dialogue together.`
}
