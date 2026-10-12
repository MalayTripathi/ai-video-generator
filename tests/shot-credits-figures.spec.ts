import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { primary } from './fixed-users'
import { admin } from './supabase-test-session'
import { insertChainProject, runChain } from './helpers/shot-chain'
import { throwingGateway } from './helpers/claude-fakes'
import { durationConfig, type DurationTarget } from '../src/lib/config/duration'
import { MEASURED_AVG_SHOT_SECONDS, remainingShotQuoteCredits, shotGenerationCredits, tierShotCount } from '../src/lib/config/credits'

// Layer: api. Every shot-generation credit figure comes from one quote - the tier's maximum
// seconds over the measured average shot, at 2 credits a shot (shotGenerationCredits; the
// remaining scenes' seconds for "Generate remaining shots"): the hold, the 402 pre-flight
// and its banner's numbers, the confirm modal, and the intake check. The tier cards' shot
// counts, the whole-video estimate and the hold all come from the same measured average.
// The whole-video estimate (estimateCredits) is display only and gates nothing.

const ROOT = join(__dirname, '..')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')

test.describe('shot-generation credit figures - one function', () => {
  test('the hold is the tier maximum over the measured average shot, x 2 credits: 16 / 30 / 72 / 144', () => {
    expect(MEASURED_AVG_SHOT_SECONDS).toBe(8.45)
    expect((Object.keys(durationConfig) as DurationTarget[]).map(shotGenerationCredits)).toEqual([16, 30, 72, 144])
    for (const [tier, config] of Object.entries(durationConfig) as [DurationTarget, (typeof durationConfig)[DurationTarget]][]) {
      expect(shotGenerationCredits(tier)).toBe(2 * Math.ceil(config.targetSecondsMax / MEASURED_AVG_SHOT_SECONDS))
      expect(Object.hasOwn(config, 'estimatedCredits')).toBe(false)
      // No second shot-count figure is left to disagree with it.
      expect(Object.hasOwn(config, 'targetShots')).toBe(false)
    }
  })

  test('one shot-length source: the tier cards, the whole-video estimate and the hold agree on the shot count', () => {
    for (const tier of Object.keys(durationConfig) as DurationTarget[]) {
      expect(shotGenerationCredits(tier)).toBe(2 * tierShotCount(tier))
    }
    // The estimate's frame part is tierShotCount x one frame (asserted per preset and tier in
    // quality-settings.spec.ts); here, that no other count can reach it.
    expect((Object.keys(durationConfig) as DurationTarget[]).map(tierShotCount)).toEqual([8, 15, 36, 72])
    // The intake tier cards and the estimate both render tierShotCount - never a literal.
    expect(read('src/app/(app)/projects/new/_components/intake-form.tsx')).toMatch(/~\{tierShotCount\(value\)\} shots/)
    expect(read('src/lib/quality/estimate.ts')).toMatch(/tierShotCount\(params\.durationTarget\) \* frameCredits/)
  })

  test('"Generate remaining shots" holds only what the unwritten scenes may still be asked for', () => {
    // 3-5 min: a scene's share of the maximum is its target x 300 / 240.
    expect(remainingShotQuoteCredits('3-5min', [{ targetSeconds: 48, writtenSeconds: 0 }])).toBe(2 * Math.ceil(60 / 8.45))
    expect(remainingShotQuoteCredits('3-5min', [{ targetSeconds: 48, writtenSeconds: 20 }])).toBe(2 * Math.ceil(40 / 8.45))
  })

  test('the 402 for generate and for "Generate remaining shots" both carry that figure', async () => {
    const projectId = await insertChainProject(primary.user.id, { duration_target: '3-5min' })
    const generate = await runChain({ projectId, userId: primary.user.id, gateway: throwingGateway('never'), balance: 0 })
    expect(generate.request).toMatchObject({ status: 402, requiredCredits: shotGenerationCredits('3-5min'), balanceCredits: 0 })

    // A scene plan with a scene no run has written: what "remaining" writes.
    const now = new Date().toISOString()
    await admin.from('scenes').insert({ project_id: projectId, position: 0, title: 'A', target_seconds: 240, created_at: now, updated_at: now })
    const remaining = await runChain({ projectId, userId: primary.user.id, gateway: throwingGateway('never'), balance: 0, mode: 'remaining' })
    expect(remaining.request).toMatchObject({ status: 402, requiredCredits: remainingShotQuoteCredits('3-5min', [{ targetSeconds: 240, writtenSeconds: 0 }]) })
  })

  test('the Workbench modal, the shots request and the intake check read that function; nothing else computes the figure', () => {
    expect(read('src/app/(app)/projects/[id]/workbench/page.tsx')).toMatch(/shotGenerationCredits\(project\.duration_target\)/)
    expect(read('src/app/api/projects/[id]/shots/logic.ts')).toMatch(/shotGenerationCredits\(project\.duration_target\)/)
    expect(read('src/app/(app)/projects/new/actions.ts')).toMatch(/shotGenerationCredits\(durationTarget\)/)
    expect(read('src/app/(app)/projects/new/_components/intake-form.tsx')).toMatch(/shotGenerationCredits\(durationTarget\)/)
    expect(read('src/app/(app)/projects/[id]/workbench/_components/retry-confirm-modal.tsx')).toMatch(/shotListCredits/)
    expect(read('src/app/(app)/projects/[id]/workbench/page.tsx')).toMatch(/remainingShotQuoteCredits\(/)
    expect(read('src/app/api/projects/[id]/shots/logic.ts')).toMatch(/remainingShotQuoteCredits\(project\.duration_target/)
    expect(read('src/app/(app)/projects/[id]/workbench/_components/shots-tab.tsx')).toMatch(/confirmMode === 'remaining' \? remainingCredits : shotListCredits/)
  })

  test('the whole-video estimate is display only: only the intake form and the quality picker use it', () => {
    const users = execSync(`grep -rl "estimateCredits(" src`, { cwd: ROOT, encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter((f) => f !== 'src/lib/quality/estimate.ts')
      .sort()
    expect(users).toEqual(['src/app/(app)/projects/new/_components/intake-form.tsx', 'src/components/quality/quality-picker.tsx'])
  })
})
