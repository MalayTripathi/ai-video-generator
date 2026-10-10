import { test, expect } from '@playwright/test'
import { assertLiveCallsAllowed } from '../src/lib/claude'

// Test-only environment mutation to exercise the guard's branches, not app code.
const env = process.env as Record<string, string | undefined>

test.describe('assertLiveCallsAllowed', () => {
  const originalAppEnv = env.APP_ENV
  const originalAllow = env.ALLOW_REAL_CLAUDE
  const originalBlock = env.BLOCK_PROVIDER_CALLS

  test.afterEach(() => {
    env.APP_ENV = originalAppEnv
    if (originalBlock === undefined) delete env.BLOCK_PROVIDER_CALLS
    else env.BLOCK_PROVIDER_CALLS = originalBlock
    if (originalAllow === undefined) delete env.ALLOW_REAL_CLAUDE
    else env.ALLOW_REAL_CLAUDE = originalAllow
  })

  test('throws on local when ALLOW_REAL_CLAUDE is unset', () => {
    env.APP_ENV = 'local'
    delete env.ALLOW_REAL_CLAUDE
    expect(() => assertLiveCallsAllowed()).toThrow(/ALLOW_REAL_CLAUDE/)
  })

  // The opt-out only exists with the provider block off; with it on, the opt-out is
  // refused (tests/provider-block.spec.ts).
  test('does not throw when ALLOW_REAL_CLAUDE is 1 and the provider block is off', () => {
    env.APP_ENV = 'local'
    delete env.BLOCK_PROVIDER_CALLS
    env.ALLOW_REAL_CLAUDE = '1'
    expect(() => assertLiveCallsAllowed()).not.toThrow()
  })
})
