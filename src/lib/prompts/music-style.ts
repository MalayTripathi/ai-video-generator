import type Anthropic from '@anthropic-ai/sdk'
import { MUSIC_STYLE_PROMPT_MAX_CHARS } from '@/lib/config/storyboard'

// The music style prompt (Storyboard D): one line of instruments, mood and tempo for an
// instrumental bed, derived once per project from the film's narration (or, with none,
// its shot descriptions). Bump the suffix on any content change.
export const MUSIC_STYLE_PROMPT_V1 = `You write the style prompt for a short film's instrumental background music.

Read the film's narration (or, when there is none, its shot descriptions) and call write_music_style exactly once with a single line naming the instruments, the mood and the tempo - for example "Slow tabla and sustained strings, reverent, unhurried".

Rules:
- Under ${MUSIC_STYLE_PROMPT_MAX_CHARS} characters, one line, no quotation marks.
- Instrumental only: never mention vocals, lyrics, singers or words.
- Never name an artist, band, song or copyrighted work.
- Match the film's subject and tone; prefer restraint - it sits under a voiceover.`

export const WRITE_MUSIC_STYLE_TOOL: Anthropic.Tool = {
  name: 'write_music_style',
  description: `Report the one-line music style prompt (instruments, mood, tempo), under ${MUSIC_STYLE_PROMPT_MAX_CHARS} characters.`,
  input_schema: {
    type: 'object',
    properties: {
      style: {
        type: 'string',
        description: `One line, under ${MUSIC_STYLE_PROMPT_MAX_CHARS} characters: instruments, mood and tempo.`,
      },
    },
    required: ['style'],
  },
}

/** The film text the style is derived from, as the prompt's dynamic block. */
export function buildMusicStyleBlock(source: { kind: 'narration' | 'descriptions'; text: string }): string {
  const label = source.kind === 'narration' ? 'Narration' : 'Shot descriptions'
  return `${label}:\n${source.text}`
}

/**
 * The model's answer as the stored prompt: one line, whitespace collapsed, surrounding
 * quotes dropped, and held under the limit at a word boundary. Null when nothing usable.
 */
export function cleanMusicStyle(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  let line = raw.replace(/\s+/g, ' ').trim().replace(/^["'“”]+|["'“”]+$/g, '').trim()
  if (line.length >= MUSIC_STYLE_PROMPT_MAX_CHARS) {
    const cut = line.slice(0, MUSIC_STYLE_PROMPT_MAX_CHARS - 1)
    const space = cut.lastIndexOf(' ')
    line = (space > 40 ? cut.slice(0, space) : cut).replace(/[\s,;:—-]+$/, '')
  }
  return line === '' ? null : line
}
