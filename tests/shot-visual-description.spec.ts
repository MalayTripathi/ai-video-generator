import { test, expect } from '@playwright/test'
import { visualDescriptionIsValid, EMPTY_VISUAL_DESCRIPTION_MESSAGE } from '../src/lib/shot-visual-description'

test.describe('visualDescriptionIsValid', () => {
  test('a non-empty visual description is valid', () => {
    expect(visualDescriptionIsValid('The Taj Mahal at sunrise.')).toBe(true)
  })

  test('an empty visual description is invalid', () => {
    expect(visualDescriptionIsValid('')).toBe(false)
  })

  test('a whitespace-only visual description is invalid once trimmed', () => {
    expect(visualDescriptionIsValid('   '.trim())).toBe(false)
  })

  test('EMPTY_VISUAL_DESCRIPTION_MESSAGE states the way out, not just the rule', () => {
    expect(EMPTY_VISUAL_DESCRIPTION_MESSAGE).toMatch(/image or video/i)
  })
})
