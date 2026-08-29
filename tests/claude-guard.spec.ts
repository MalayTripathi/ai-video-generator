import { test, expect } from '@playwright/test'
import { assertLiveCallsAllowed } from '../src/lib/claude'

// NODE_ENV is typed read-only by Next.js's env types; this is test-only environment
// mutation to exercise the guard's branches, not app code.
const env = process.env as Record<string, string | undefined>

test.describe('assertLiveCallsAllowed', () => {
  const originalNodeEnv = env.NODE_ENV
  const originalAllow = env.ALLOW_REAL_CLAUDE

  test.afterEach(() => {
    env.NODE_ENV = originalNodeEnv
    if (originalAllow === undefined) delete env.ALLOW_REAL_CLAUDE
    else env.ALLOW_REAL_CLAUDE = originalAllow
  })

  test('throws outside production when ALLOW_REAL_CLAUDE is unset', () => {
    env.NODE_ENV = 'test'
    delete env.ALLOW_REAL_CLAUDE
    expect(() => assertLiveCallsAllowed()).toThrow(/ALLOW_REAL_CLAUDE/)
  })

  test('does not throw when ALLOW_REAL_CLAUDE is 1', () => {
    env.NODE_ENV = 'test'
    env.ALLOW_REAL_CLAUDE = '1'
    expect(() => assertLiveCallsAllowed()).not.toThrow()
  })
})
