import { test, expect } from '@playwright/test'
import { formatClockTime } from '../src/lib/format-clock-time'

// The one clock-time formatter. Pure - `now` is injected, and dates are built in local time
// so the assertions hold in any runner timezone.

const NOW = new Date(2026, 8, 24, 15, 0) // Sep 24, 3:00 PM local

test.describe('formatClockTime', () => {
  test('today, PM', () => {
    expect(formatClockTime(new Date(2026, 8, 24, 14, 36), NOW)).toBe('2:36 PM')
  })

  test('today, AM, with a zero-padded minute', () => {
    expect(formatClockTime(new Date(2026, 8, 24, 9, 5), NOW)).toBe('9:05 AM')
  })

  test('midnight and noon read as 12', () => {
    expect(formatClockTime(new Date(2026, 8, 24, 0, 0), NOW)).toBe('12:00 AM')
    expect(formatClockTime(new Date(2026, 8, 24, 12, 30), NOW)).toBe('12:30 PM')
  })

  test('any other day carries the month and day', () => {
    expect(formatClockTime(new Date(2026, 8, 20, 14, 36), NOW)).toBe('Sep 20, 2:36 PM')
    expect(formatClockTime(new Date(2026, 8, 23, 23, 59), NOW)).toBe('Sep 23, 11:59 PM')
    expect(formatClockTime(new Date(2025, 8, 24, 8, 1), NOW)).toBe('Sep 24, 8:01 AM')
  })

  test('accepts an ISO string', () => {
    const at = new Date(2026, 8, 24, 16, 45)
    expect(formatClockTime(at.toISOString(), NOW)).toBe('4:45 PM')
  })
})
