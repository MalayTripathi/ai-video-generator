import { test, expect } from '@playwright/test'
import { hasUsablePrompt } from '../src/lib/prompts/prompt-validation'
import { resolveImagePromptResults } from '../src/app/api/projects/[id]/image-prompts/logic'

const GOOD_IMAGE_PROMPT =
  'A warm, detailed shot with rich color and lighting that fully describes the moment for an image generation model.'

test.describe('write_image_prompts validation', () => {
  test('rejects an empty prompt string as unusable', () => {
    expect(hasUsablePrompt('')).toBe(false)
    expect(hasUsablePrompt('   ')).toBe(false)
    expect(hasUsablePrompt('too short')).toBe(false)
    expect(hasUsablePrompt(GOOD_IMAGE_PROMPT)).toBe(true)
  })

  test('a shot stubbed with an empty write_image_prompts entry is excluded from persistence and reported missing', () => {
    // Simulates Claude's raw write_image_prompts tool input for a 3-shot request
    // where the response for s001 is empty (the exact failure mode this route's
    // predecessor was built to reject).
    const rawPrompts = [
      { shot_key: 'b2c3d', image_prompt: '' },
      { shot_key: 'f4g5h', image_prompt: GOOD_IMAGE_PROMPT },
      { shot_key: 'j6k7m', image_prompt: GOOD_IMAGE_PROMPT },
    ]

    const { validEntries, missingShotKeys } = resolveImagePromptResults(rawPrompts, [
      'b2c3d',
      'f4g5h',
      'j6k7m',
    ])

    // b2c3d's garbage entry never reaches persistence - it's simply not in
    // validEntries, so the route's .update() call for it never happens and the
    // shot's column stays untouched rather than being overwritten with "".
    expect(validEntries.map((e) => e.shot_key).sort()).toEqual(['f4g5h', 'j6k7m'])

    // Reported so the caller can surface an error and skip charging for it.
    expect(missingShotKeys).toEqual(['b2c3d'])
  })

  test('an entry for a shot_key outside the requested scope is dropped, not persisted', () => {
    const rawPrompts = [
      { shot_key: 'b2c3d', image_prompt: GOOD_IMAGE_PROMPT },
      { shot_key: 'outsider', image_prompt: GOOD_IMAGE_PROMPT },
    ]

    const { validEntries, missingShotKeys } = resolveImagePromptResults(rawPrompts, ['b2c3d'])

    expect(validEntries.map((e) => e.shot_key)).toEqual(['b2c3d'])
    expect(missingShotKeys).toEqual([])
  })

  test('fewer entries than requested are reported as missing', () => {
    const rawPrompts = [{ shot_key: 'f4g5h', image_prompt: GOOD_IMAGE_PROMPT }]

    const { validEntries, missingShotKeys } = resolveImagePromptResults(rawPrompts, ['b2c3d', 'f4g5h'])

    expect(validEntries.map((e) => e.shot_key)).toEqual(['f4g5h'])
    expect(missingShotKeys).toEqual(['b2c3d'])
  })

  test('all valid entries leave no missing shot_keys', () => {
    const rawPrompts = [
      { shot_key: 'b2c3d', image_prompt: GOOD_IMAGE_PROMPT },
      { shot_key: 'f4g5h', image_prompt: GOOD_IMAGE_PROMPT },
    ]

    const { validEntries, missingShotKeys } = resolveImagePromptResults(rawPrompts, ['b2c3d', 'f4g5h'])

    expect(validEntries).toHaveLength(2)
    expect(missingShotKeys).toEqual([])
  })
})
