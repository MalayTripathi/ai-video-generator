import { test, expect } from '@playwright/test'
import { stalenessFor } from '../src/lib/shot-staleness'

test.describe('stalenessFor', () => {
  test('voice_over sets both shot prompt flags and the project voiceover flag', () => {
    expect(stalenessFor('voice_over')).toEqual({
      shot: { image_prompt_stale: true, video_prompt_stale: true },
      project: { voiceover_stale: true },
    })
  })

  test('visual_description sets both shot prompt flags, no project flag', () => {
    expect(stalenessFor('visual_description')).toEqual({
      shot: { image_prompt_stale: true, video_prompt_stale: true },
      project: {},
    })
  })

  test('camera sets both shot prompt flags, no project flag - same as visual_description', () => {
    expect(stalenessFor('camera')).toEqual({
      shot: { image_prompt_stale: true, video_prompt_stale: true },
      project: {},
    })
  })

  test('dialogue sets video_prompt_stale only - on-camera speech, not narration', () => {
    expect(stalenessFor('dialogue')).toEqual({
      shot: { video_prompt_stale: true },
      project: {},
    })
  })

  test('duration sets nothing - audio derives from narration text, not duration', () => {
    expect(stalenessFor('duration')).toEqual({
      shot: {},
      project: {},
    })
  })
})
