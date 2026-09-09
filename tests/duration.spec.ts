import { test, expect } from '@playwright/test'
import { shotCountOverrun } from '../src/lib/config/duration'

test.describe('shotCountOverrun', () => {
  test('returns 0 when the shot count is at the target', () => {
    expect(shotCountOverrun(8, 8)).toBe(0)
  })

  test('returns 0 when the shot count is under the target', () => {
    expect(shotCountOverrun(5, 8)).toBe(0)
  })

  test('returns the positive delta when the shot count exceeds the target', () => {
    expect(shotCountOverrun(11, 8)).toBe(3)
  })

  test('returns 0 for a null/unresolved target - never a negative or NaN result', () => {
    expect(shotCountOverrun(11, null)).toBe(0)
  })
})
