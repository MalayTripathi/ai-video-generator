import { test, expect } from '@playwright/test'
import { hasUsablePrompt, needsPrompts, resolvePromptResults } from '../src/app/api/projects/[id]/prompts/logic'

const GOOD_IMAGE_PROMPT =
  'A warm, detailed scene with rich color and lighting that fully describes the moment for an image generation model.'
const GOOD_VIDEO_PROMPT =
  'A slow, deliberate camera movement across the scene, describing exactly how motion unfolds within the frame.'

test.describe('write_prompts validation', () => {
  test('rejects an empty prompt string as unusable', () => {
    expect(hasUsablePrompt('')).toBe(false)
    expect(hasUsablePrompt('   ')).toBe(false)
    expect(hasUsablePrompt('too short')).toBe(false)
    expect(hasUsablePrompt(GOOD_IMAGE_PROMPT)).toBe(true)
  })

  test('a scene with an empty-string prompt still needs regeneration', () => {
    expect(needsPrompts({ image_prompt: '', video_prompt: '' })).toBe(true)
    expect(needsPrompts({ image_prompt: null, video_prompt: null })).toBe(true)
    expect(needsPrompts({ image_prompt: GOOD_IMAGE_PROMPT, video_prompt: GOOD_VIDEO_PROMPT })).toBe(
      false
    )
  })

  test('a scene stubbed with an empty write_prompts entry is excluded from persistence and reported missing', () => {
    // Simulates Claude's raw write_prompts tool input for a 3-scene request
    // where the response for s001 is empty (the exact failure mode observed
    // in production).
    const rawPrompts = [
      { scene_key: 's001', image_prompt: '', video_prompt: '' },
      { scene_key: 's002', image_prompt: GOOD_IMAGE_PROMPT, video_prompt: GOOD_VIDEO_PROMPT },
      { scene_key: 's003', image_prompt: GOOD_IMAGE_PROMPT, video_prompt: GOOD_VIDEO_PROMPT },
    ]

    const { validEntries, missingSceneKeys } = resolvePromptResults(rawPrompts, [
      's001',
      's002',
      's003',
    ])

    // s001's garbage entry never reaches persistence - it's simply not in
    // validEntries, so the route's .update() call for it never happens and
    // the scene's columns stay null rather than being overwritten with "".
    expect(validEntries.map((e) => e.scene_key).sort()).toEqual(['s002', 's003'])

    // Reported so the caller can gate wizard advancement and surface an error.
    expect(missingSceneKeys).toEqual(['s001'])
  })

  test('fewer entries than requested are reported as missing', () => {
    const rawPrompts = [
      { scene_key: 's002', image_prompt: GOOD_IMAGE_PROMPT, video_prompt: GOOD_VIDEO_PROMPT },
    ]

    const { validEntries, missingSceneKeys } = resolvePromptResults(rawPrompts, ['s001', 's002'])

    expect(validEntries.map((e) => e.scene_key)).toEqual(['s002'])
    expect(missingSceneKeys).toEqual(['s001'])
  })

  test('all valid entries leave no missing scene_keys', () => {
    const rawPrompts = [
      { scene_key: 's001', image_prompt: GOOD_IMAGE_PROMPT, video_prompt: GOOD_VIDEO_PROMPT },
      { scene_key: 's002', image_prompt: GOOD_IMAGE_PROMPT, video_prompt: GOOD_VIDEO_PROMPT },
    ]

    const { validEntries, missingSceneKeys } = resolvePromptResults(rawPrompts, ['s001', 's002'])

    expect(validEntries).toHaveLength(2)
    expect(missingSceneKeys).toEqual([])
  })
})
