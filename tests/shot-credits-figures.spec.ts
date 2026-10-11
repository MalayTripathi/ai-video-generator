import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { primary } from './fixed-users'
import { admin } from './supabase-test-session'
import { insertChainProject, runChain } from './helpers/shot-chain'
import { throwingGateway } from './helpers/claude-fakes'
import { durationConfig, type DurationTarget } from '../src/lib/config/duration'
import { shotGenerationCredits } from '../src/lib/config/credits'

// Layer: api. Every shot-generation credit figure comes from one function -
// shotGenerationCredits, 2 x the tier's target shots: the 402 pre-flight (generate, retry
// and remaining) and its banner's numbers, the confirm modal, and the intake balance check.
// The whole-video estimate (estimateCredits) is display only and gates nothing.

const ROOT = join(__dirname, '..')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')

test.describe('shot-generation credit figures - one function', () => {
  test('the rule is 2 x target shots for every tier, and no hand-set estimate is left', () => {
    for (const [tier, config] of Object.entries(durationConfig) as [DurationTarget, (typeof durationConfig)[DurationTarget]][]) {
      expect(shotGenerationCredits(tier)).toBe(2 * config.targetShots)
      expect(Object.hasOwn(config, 'estimatedCredits')).toBe(false)
    }
  })

  test('the 402 for generate and for "Generate remaining shots" both carry that figure', async () => {
    const projectId = await insertChainProject(primary.user.id, { duration_target: '3-5min' })
    const generate = await runChain({ projectId, userId: primary.user.id, gateway: throwingGateway('never'), balance: 0 })
    expect(generate.request).toMatchObject({ status: 402, requiredCredits: shotGenerationCredits('3-5min'), balanceCredits: 0 })

    // A scene plan with a scene no run has written: what "remaining" writes.
    const now = new Date().toISOString()
    await admin.from('scenes').insert({ project_id: projectId, position: 0, title: 'A', target_seconds: 240, created_at: now, updated_at: now })
    const remaining = await runChain({ projectId, userId: primary.user.id, gateway: throwingGateway('never'), balance: 0, mode: 'remaining' })
    expect(remaining.request).toMatchObject({ status: 402, requiredCredits: shotGenerationCredits('3-5min') })
  })

  test('the Workbench modal, the shots request and the intake check read that function; nothing else computes the figure', () => {
    expect(read('src/app/(app)/projects/[id]/workbench/page.tsx')).toMatch(/shotGenerationCredits\(project\.duration_target\)/)
    expect(read('src/app/api/projects/[id]/shots/logic.ts')).toMatch(/shotGenerationCredits\(project\.duration_target\)/)
    expect(read('src/app/(app)/projects/new/actions.ts')).toMatch(/shotGenerationCredits\(durationTarget\)/)
    expect(read('src/app/(app)/projects/new/_components/intake-form.tsx')).toMatch(/shotGenerationCredits\(durationTarget\)/)
    expect(read('src/app/(app)/projects/[id]/workbench/_components/retry-confirm-modal.tsx')).toMatch(/shotListCredits/)
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
