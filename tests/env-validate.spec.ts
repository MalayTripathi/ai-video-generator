import { test, expect } from '@playwright/test'
import { ENV_VARS, EnvError, parseEnv, type EnvSource } from '../src/lib/config/env'
import {
  SHOT_CHAIN_TIMING,
  SHOTS_ROUTE_MAX_DURATION_S,
  shotRunBudgetMs,
  worstChunkS,
  worstOutlineS,
} from '../src/lib/config/shot-timing'

// Layer: api. src/lib/config/env.ts's validator, driven with injected sources - never the
// real process env. Each failure must throw an EnvError naming the var it is about.

const SECRET = 'x'.repeat(32)

/** A complete, valid source for `appEnv`, every class B var set explicitly. */
function valid(appEnv: 'local' | 'preview' | 'production'): EnvSource {
  return {
    APP_ENV: appEnv,
    NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon',
    SUPABASE_SERVICE_ROLE_KEY: 'service',
    ANTHROPIC_API_KEY: 'a',
    OPENAI_API_KEY: 'o',
    ELEVENLABS_API_KEY: 'e',
    INTERNAL_CONTINUATION_SECRET: SECRET,
    SPEND_CAP_ENABLED: '0',
    SPEND_CAP_MONTHLY_USD: '100',
    CLAUDE_SHOTS_MODEL: 'claude-sonnet-5',
    CLAUDE_SHOT_OUTLINE_MAX_TOKENS: '8000',
    CLAUDE_SHOTS_MAX_TOKENS: '8000',
    CLAUDE_CAMERA_MODEL: 'claude-haiku-5-5',
    CLAUDE_CAMERA_MAX_TOKENS: '500',
    CLAUDE_AGENT_MODEL: 'claude-sonnet-5',
    CLAUDE_AGENT_MAX_TOKENS: '8192',
    CLAUDE_IMAGE_PROMPTS_MODEL: 'claude-sonnet-5',
    CLAUDE_IMAGE_PROMPTS_MAX_TOKENS: '8192',
    CLAUDE_MUSIC_PROMPT_MODEL: 'claude-haiku-5-5',
    CLAUDE_MUSIC_PROMPT_MAX_TOKENS: '500',
    VOICEOVER_PROVIDER: 'elevenlabs',
    ELEVENLABS_VOICEOVER_MODEL: 'eleven_v3',
    MUSIC_PROVIDER: 'elevenlabs',
    ELEVENLABS_MUSIC_MODEL: 'music_v1',
    ...(appEnv === 'production' ? {} : { IMAGE_QUALITY_DEV_CAP: 'low' }),
    ...(appEnv === 'preview' ? { VERCEL_AUTOMATION_BYPASS_SECRET: 'bypass' } : {}),
  }
}

const without = (source: EnvSource, name: string): EnvSource => {
  const copy = { ...source }
  delete copy[name]
  return copy
}

/** Asserts parseEnv throws an EnvError about `name`. */
function expectRejects(source: EnvSource, name: string, scope: 'next' | 'worker' = 'next') {
  let thrown: unknown
  try {
    parseEnv(source, scope)
  } catch (err) {
    thrown = err
  }
  expect(thrown, `expected ${name} to be rejected`).toBeInstanceOf(EnvError)
  expect((thrown as EnvError).varName).toBe(name)
  expect((thrown as EnvError).message).toContain(name)
}

const varsOf = (cls: string) => Object.entries(ENV_VARS).filter(([, c]) => c === cls).map(([name]) => name)

test.describe('env validation', () => {
  test('a complete source passes in every environment, with no warnings', () => {
    for (const appEnv of ['local', 'preview', 'production'] as const) {
      expect(parseEnv(valid(appEnv), 'next').warnings).toEqual([])
    }
  })

  test('class A: each var missing or empty fails boot everywhere, naming it', () => {
    for (const appEnv of ['local', 'preview', 'production'] as const) {
      for (const name of varsOf('A')) {
        expectRejects(without(valid(appEnv), name), name)
        expectRejects({ ...valid(appEnv), [name]: '  ' }, name)
      }
    }
  })

  test('class A: malformed values fail', () => {
    const base = valid('local')
    expectRejects({ ...base, APP_ENV: 'staging' }, 'APP_ENV')
    expectRejects({ ...base, INTERNAL_CONTINUATION_SECRET: 'x'.repeat(31) }, 'INTERNAL_CONTINUATION_SECRET')
    expectRejects({ ...base, SPEND_CAP_ENABLED: 'true' }, 'SPEND_CAP_ENABLED')
    for (const usd of ['0', '-5', 'abc', '100usd']) expectRejects({ ...base, SPEND_CAP_MONTHLY_USD: usd }, 'SPEND_CAP_MONTHLY_USD')
  })

  test('class B: each var missing fails on preview and production, naming it', () => {
    for (const appEnv of ['preview', 'production'] as const) {
      for (const name of varsOf('B')) expectRejects(without(valid(appEnv), name), name)
    }
  })

  test('class B: unset on local takes the dev value and warns once per var', () => {
    const source = valid('local')
    for (const name of varsOf('B')) delete source[name]
    const { env, warnings } = parseEnv(source, 'next')
    expect(warnings).toHaveLength(varsOf('B').length)
    expect(warnings).toContain('CLAUDE_SHOTS_MODEL=claude-haiku-5-5')
    expect(warnings).toContain('CLAUDE_AGENT_MAX_TOKENS=8192')
    expect(warnings).toContain('ELEVENLABS_VOICEOVER_MODEL=eleven_v3')
    expect(env.claude.agentModel).toBe('claude-haiku-5-5')
    expect(env.claude.cameraMaxTokens).toBe(500)
  })

  test('class B: unknown model ids, unsupported providers and bad caps fail', () => {
    const base = valid('local')
    expectRejects({ ...base, CLAUDE_AGENT_MODEL: 'claude-unknown-9' }, 'CLAUDE_AGENT_MODEL')
    expectRejects({ ...base, CLAUDE_SHOTS_MODEL: 'gpt-4o' }, 'CLAUDE_SHOTS_MODEL')
    expectRejects({ ...base, ELEVENLABS_VOICEOVER_MODEL: 'eleven_v2' }, 'ELEVENLABS_VOICEOVER_MODEL')
    expectRejects({ ...base, ELEVENLABS_MUSIC_MODEL: 'music_v9' }, 'ELEVENLABS_MUSIC_MODEL')
    expectRejects({ ...base, VOICEOVER_PROVIDER: 'openai' }, 'VOICEOVER_PROVIDER')
    expectRejects({ ...base, MUSIC_PROVIDER: 'suno' }, 'MUSIC_PROVIDER')
    for (const cap of ['abc', '8000.5', '0', '99', '64001']) expectRejects({ ...base, CLAUDE_SHOTS_MAX_TOKENS: cap }, 'CLAUDE_SHOTS_MAX_TOKENS')
  })

  test('class C: the image dev cap is required on local and preview, refused on production', () => {
    expectRejects(without(valid('local'), 'IMAGE_QUALITY_DEV_CAP'), 'IMAGE_QUALITY_DEV_CAP')
    expectRejects(without(valid('preview'), 'IMAGE_QUALITY_DEV_CAP'), 'IMAGE_QUALITY_DEV_CAP')
    expectRejects({ ...valid('local'), IMAGE_QUALITY_DEV_CAP: 'ultra' }, 'IMAGE_QUALITY_DEV_CAP')
    expectRejects({ ...valid('production'), IMAGE_QUALITY_DEV_CAP: 'low' }, 'IMAGE_QUALITY_DEV_CAP')
    expect(parseEnv(valid('production'), 'next').env.imageQualityDevCap).toBeNull()
    expect(parseEnv(valid('preview'), 'next').env.imageQualityDevCap).toBe('low')
  })

  test('class D: unset takes the default silently; a malformed value fails, never falls back', () => {
    const { env, warnings } = parseEnv(valid('local'), 'next')
    expect(warnings).toEqual([])
    expect(env.tuning).toMatchObject({ exportCrf: 20, exportPollMs: 4000, blockProviderCalls: false, ffmpegPath: null })
    expect(parseEnv({ ...valid('local'), EXPORT_POLL_MS: '' }, 'next').env.tuning.exportPollMs).toBe(4000)
    for (const name of varsOf('D').filter((n) => n.startsWith('EXPORT_'))) expectRejects({ ...valid('local'), [name]: 'abc' }, name)
    expectRejects({ ...valid('local'), EXPORT_CRF: '99' }, 'EXPORT_CRF')
    expectRejects({ ...valid('local'), BLOCK_PROVIDER_CALLS: 'yes' }, 'BLOCK_PROVIDER_CALLS')
    expect(parseEnv({ ...valid('local'), BLOCK_PROVIDER_CALLS: '1' }, 'next').env.tuning.blockProviderCalls).toBe(true)
  })

  test('APP_ENV must match VERCEL_ENV when the platform sets one', () => {
    expectRejects({ ...valid('preview'), VERCEL_ENV: 'production' }, 'APP_ENV')
    expectRejects({ ...valid('production'), VERCEL_ENV: 'preview' }, 'APP_ENV')
    expectRejects({ ...valid('local'), VERCEL_ENV: 'preview' }, 'APP_ENV')
    expect(() => parseEnv({ ...valid('preview'), VERCEL_ENV: 'preview' }, 'next')).not.toThrow()
    expect(() => parseEnv({ ...valid('local'), VERCEL_ENV: 'development' }, 'next')).not.toThrow()
  })

  test('the worker scope requires its own vars only', () => {
    const worker: EnvSource = {
      APP_ENV: 'production',
      NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'service',
      SPEND_CAP_ENABLED: '0',
      SPEND_CAP_MONTHLY_USD: '100',
    }
    expect(() => parseEnv(worker, 'worker')).not.toThrow()
    for (const name of Object.keys(worker)) expectRejects(without(worker, name), name, 'worker')
    expectRejects({ ...worker, EXPORT_FPS: 'fast' }, 'EXPORT_FPS', 'worker')
  })

  test('class G: the deployment protection bypass is required on preview, optional on production, ignored on local', () => {
    expectRejects(without(valid('preview'), 'VERCEL_AUTOMATION_BYPASS_SECRET'), 'VERCEL_AUTOMATION_BYPASS_SECRET')
    expect(parseEnv(valid('preview'), 'next').env.deploymentBypassSecret).toBe('bypass')
    expect(parseEnv(valid('production'), 'next').env.deploymentBypassSecret).toBeNull()
    expect(parseEnv({ ...valid('production'), VERCEL_AUTOMATION_BYPASS_SECRET: 'p' }, 'next').env.deploymentBypassSecret).toBe('p')
    expect(parseEnv({ ...valid('local'), VERCEL_AUTOMATION_BYPASS_SECRET: 'l' }, 'next').env.deploymentBypassSecret).toBeNull()
  })

  test('the shot chain: a shots model with no measured or estimated timing fails boot, as does a max_tokens the chain cannot fit', () => {
    // Haiku 4.5 is priced but its chain timing was never measured - boot fails rather than guess.
    expectRejects({ ...valid('production'), CLAUDE_SHOTS_MODEL: 'claude-haiku-4-5-20251001' }, 'CLAUDE_SHOTS_MODEL')
    // 64,000 tokens on Haiku 5.5 (~1,190s) cannot fit any run.
    expectRejects({ ...valid('production'), CLAUDE_SHOTS_MODEL: 'claude-haiku-5-5', CLAUDE_SHOTS_MAX_TOKENS: '64000' }, 'CLAUDE_SHOTS_MODEL')
    expect(() => parseEnv({ ...valid('production'), CLAUDE_SHOTS_MODEL: 'claude-haiku-5-5' }, 'next')).not.toThrow()
  })
})

test.describe('shot chain run budget - derived per model, never hand-set', () => {
  test('Haiku 5.5 from the Oct 10 measurements, Sonnet from a labelled estimate, both at the 8,000-token max_tokens', () => {
    expect(SHOT_CHAIN_TIMING['claude-haiku-5-5'].basis).toBe('measured')
    expect(SHOT_CHAIN_TIMING['claude-sonnet-5'].basis).toBe('estimate')
    // 300 - (3 + 8000/54 + 22) - 15 hand-off - 10 margin = 101.85s.
    expect(shotRunBudgetMs('claude-haiku-5-5', 8000)).toBe(101_851)
    // 300 - (3 + 8000/40 + 22) - 25 = 50s.
    expect(shotRunBudgetMs('claude-sonnet-5', 8000)).toBe(50_000)
  })

  test('no chunk started inside the budget can run past 300s, and the outline run fits too', () => {
    for (const [model, timing] of Object.entries(SHOT_CHAIN_TIMING)) {
      const budgetS = shotRunBudgetMs(model, 8000) / 1000
      expect(budgetS).toBeGreaterThan(0)
      // The latest a chunk can start is the budget; it drains, then the run hands off.
      expect(budgetS + worstChunkS(timing, 8000) + 15).toBeLessThanOrEqual(SHOTS_ROUTE_MAX_DURATION_S)
      expect(worstOutlineS(timing, 8000) + 15).toBeLessThanOrEqual(SHOTS_ROUTE_MAX_DURATION_S)
    }
  })
})
