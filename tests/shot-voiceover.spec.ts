import { test, expect } from '@playwright/test'
import { voiceOverIsValid, EMPTY_VOICEOVER_MESSAGE } from '../src/lib/shot-voiceover'

test.describe('voiceOverIsValid', () => {
  test('a non-empty voice_over is valid regardless of dialogue', () => {
    expect(voiceOverIsValid('The Taj Mahal at sunrise.', false)).toBe(true)
    expect(voiceOverIsValid('The Taj Mahal at sunrise.', true)).toBe(true)
  })

  test('an empty voice_over is valid when the shot has dialogue', () => {
    expect(voiceOverIsValid('', true)).toBe(true)
  })

  test('an empty voice_over is invalid when the shot has no dialogue', () => {
    expect(voiceOverIsValid('', false)).toBe(false)
  })

  test('EMPTY_VOICEOVER_MESSAGE states the way out, not just the rule', () => {
    expect(EMPTY_VOICEOVER_MESSAGE).toContain('narration or a dialogue line')
  })
})
