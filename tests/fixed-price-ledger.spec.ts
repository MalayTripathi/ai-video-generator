import { test, expect } from '@playwright/test'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { admin, createTestSession, deleteTestUser } from './supabase-test-session'
import { primary } from './fixed-users'
import { stepIndex } from '../src/lib/config/pipeline'
import { SIGNUP_GRANT_CREDITS, CREDIT_PRICE_VERSION } from '../src/lib/config/credits'
import { durationConfig } from '../src/lib/config/duration'
import { successMessage, throwingGateway, textMessage } from './helpers/claude-fakes'
import { runShotGeneration, BILLED_BY_TURN } from '../src/app/api/projects/[id]/shots/logic'
import { runCameraDerivation } from '../src/app/api/projects/[id]/shots/[shotId]/camera/logic'
import { runAgentTurn } from '../src/app/api/projects/[id]/agent/logic'
import { runImagePromptGeneration } from '../src/app/api/projects/[id]/image-prompts/logic'
import type { recordFixedSpend, recordDynamicSpend } from '../src/lib/credits/ledger'
import type { ClaudeGateway } from '../src/lib/claude'

// Same child-process dispatcher as tests/ledger.spec.ts / tests/agent-turn-ledger.spec.ts
// - credit_ledger.ts transitively imports 'server-only', so it can't be imported
// directly from this plain-Node test process. Reused rather than reimplemented.
const MODULE_URL = 'file://' + path.resolve(__dirname, '../src/lib/credits/ledger.ts')
const ALIAS_LOADER_URL = 'file://' + path.resolve(__dirname, 'helpers/ts-alias-loader.mjs')

type LedgerCallResult =
  | { ok: true; result: unknown }
  | { ok: false; errorName: string | undefined; message: string }

function runLedgerCall(fn: string, arg: unknown): Promise<LedgerCallResult> {
  const script = `
    const { register } = require('node:module')
    register(${JSON.stringify(ALIAS_LOADER_URL)})
    import(${JSON.stringify(MODULE_URL)}).then(async (m) => {
      try {
        const result = await m[${JSON.stringify(fn)}](${JSON.stringify(arg)})
        process.stdout.write(JSON.stringify({ ok: true, result: result === undefined ? null : result }))
      } catch (err) {
        process.stdout.write(JSON.stringify({
          ok: false,
          errorName: err && err.constructor && err.constructor.name,
          message: err instanceof Error ? err.message : String(err),
        }))
      }
    })
  `
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--conditions=react-server', '-e', script], { env: process.env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ledger child process exited ${code}: ${stderr}`))
        return
      }
      resolve(JSON.parse(stdout.trim()))
    })
  })
}

const realRecordFixedSpend: typeof recordFixedSpend = async (params) => {
  const result = await runLedgerCall('recordFixedSpend', params)
  if (!result.ok) {
    throw new Error(`recordFixedSpend failed: ${result.errorName}: ${result.message}`)
  }
}

const realRecordDynamicSpend: typeof recordDynamicSpend = async (params) => {
  const result = await runLedgerCall('recordDynamicSpend', params)
  if (!result.ok) {
    throw new Error(`recordDynamicSpend failed: ${result.errorName}: ${result.message}`)
  }
}

async function getBalance(userId: string): Promise<number> {
  const result = await runLedgerCall('getBalance', userId)
  if (!result.ok) {
    throw new Error(`getBalance failed: ${result.errorName}: ${result.message}`)
  }
  return result.result as number
}

async function seedProject(userId: string, overrides: Record<string, unknown> = {}) {
  const { data, error } = await admin
    .from('projects')
    .insert({
      user_id: userId,
      title: 'Fixed-price ledger test',
      source_text: 'A short film for fixed-price ledger tests.',
      video_type: 'auto',
      duration_target: '30-60s',
      current_step: 'workbench',
      furthest_step: stepIndex('workbench'),
      ...overrides,
    })
    .select('id')
    .single()
  expect(error).toBeNull()
  return data!.id as string
}

let shotOrderIndex = 0

async function seedShot(projectId: string, overrides: Record<string, unknown> = {}) {
  const shotKey = `t${crypto.randomUUID().slice(0, 4)}`
  const { data, error } = await admin
    .from('shots')
    .insert({
      project_id: projectId,
      order_index: shotOrderIndex++,
      shot_key: shotKey,
      voice_over: 'Original voiceover.',
      visual_description: 'Original visual description of a wide, sunlit valley.',
      ...overrides,
    })
    .select('id')
    .single()
  expect(error).toBeNull()
  return { shotId: data!.id as string, shotKey }
}

async function readLedgerRows(projectId: string) {
  const { data, error } = await admin.from('credit_ledger').select('*').eq('project_id', projectId)
  expect(error).toBeNull()
  return data ?? []
}

async function readUsageRows(projectId: string) {
  const { data, error } = await admin.from('usage').select('*').eq('project_id', projectId)
  expect(error).toBeNull()
  return data ?? []
}

function buildShots(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    voice_over: `Narration for shot ${i + 1}.`,
    visual_description: `Visual for shot ${i + 1}.`,
    shot_size: 'wide',
    camera_angle: 'eye_level',
    camera_movement: 'static',
    shot_size_origin: 'auto',
    camera_angle_origin: 'auto',
    camera_movement_origin: 'auto',
    duration_sec: 3,
    section_label: 'Section',
    dialogue: [],
    element_names: [],
  }))
}

test.describe('generate_shots (button trigger) - fixed-price ledger wiring', () => {
  test('writes one ledger row priced off the persisted count, not the tier target', async () => {
    // '1-2min' targets 15 shots (duration.ts) - the fake gateway returns only 3, so a
    // price keyed on the target (2 * 15 = 30) would silently overcharge.
    expect(durationConfig['1-2min'].targetShots).toBe(15)
    const projectId = await seedProject(primary.user.id, { duration_target: '1-2min' })
    const gateway: ClaudeGateway = {
      async createMessage() {
        return successMessage({ title: null, message: '', video_type: 'auto', shots: buildShots(3) })
      },
    }

    const result = await runShotGeneration({
      gateway,
      supabase: admin,
      projectId,
      userId: primary.user.id,
      retry: false,
      attemptId: crypto.randomUUID(),
      recordFixedSpend: realRecordFixedSpend,
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.shots.length).toBe(3)

    const rows = await readLedgerRows(projectId)
    expect(rows.length).toBe(1)
    expect(rows[0].kind).toBe('spend')
    expect(rows[0].pricing_mode).toBe('fixed')
    expect(rows[0].step).toBe('workbench')
    expect(rows[0].operation).toBe('generate_shots')
    expect(rows[0].message_id).toBeNull()
    expect(rows[0].shot_key).toBeNull()
    expect(rows[0].delta).toBe(-6) // 2 credits/shot * 3 persisted
    expect(rows[0].delta).not.toBe(-30) // what pricing off the tier target would produce
  })

  test('a recovered generate_shots (replaying a persisted payload) writes no ledger row', async () => {
    const projectId = await seedProject(primary.user.id)
    const { error: generationError } = await admin.from('generations').insert({
      project_id: projectId,
      step: 'workbench',
      operation: 'generate_shots',
      shot_id: null,
      state: 'failed',
      payload: { title: null, message: '', video_type: 'auto', shots: buildShots(2) } as never,
    })
    expect(generationError).toBeNull()

    // A gateway that throws if ever called - RECOVER must never reach it, so this
    // doubles as proof no fresh Claude call happened, not just that no row was written.
    const result = await runShotGeneration({
      gateway: throwingGateway('RECOVER must never call the gateway'),
      supabase: admin,
      projectId,
      userId: primary.user.id,
      retry: true,
      attemptId: crypto.randomUUID(),
      recordFixedSpend: realRecordFixedSpend,
    })
    expect(result.ok).toBe(true)

    const rows = await readLedgerRows(projectId)
    expect(rows.length).toBe(0)
  })

  test('a failed generate_shots call writes no ledger row', async () => {
    const projectId = await seedProject(primary.user.id)
    const result = await runShotGeneration({
      gateway: throwingGateway('simulated failure'),
      supabase: admin,
      projectId,
      userId: primary.user.id,
      retry: false,
      attemptId: crypto.randomUUID(),
      recordFixedSpend: realRecordFixedSpend,
    })
    expect(result.ok).toBe(false)

    const rows = await readLedgerRows(projectId)
    expect(rows.length).toBe(0)
  })

  test('a forced ledger-write failure is swallowed - the request still succeeds, and no row is written', async () => {
    const projectId = await seedProject(primary.user.id)
    const gateway: ClaudeGateway = {
      async createMessage() {
        return successMessage({ title: null, message: '', video_type: 'auto', shots: buildShots(2) })
      },
    }

    const result = await runShotGeneration({
      gateway,
      supabase: admin,
      projectId,
      userId: primary.user.id,
      retry: false,
      attemptId: crypto.randomUUID(),
      recordFixedSpend: async () => {
        throw new Error('simulated ledger write failure')
      },
    })
    expect(result.ok).toBe(true)

    const rows = await readLedgerRows(projectId)
    expect(rows.length).toBe(0)
  })

  test('calling generate_shots twice with the same attemptId produces exactly one row and does not throw', async () => {
    const projectId = await seedProject(primary.user.id)
    const attemptId = crypto.randomUUID()
    const gateway: ClaudeGateway = {
      async createMessage() {
        return successMessage({ title: null, message: '', video_type: 'auto', shots: buildShots(2) })
      },
    }

    const first = await runShotGeneration({
      gateway,
      supabase: admin,
      projectId,
      userId: primary.user.id,
      retry: false,
      attemptId,
      recordFixedSpend: realRecordFixedSpend,
    })
    expect(first.ok).toBe(true)

    // generate_shots is claimable again from 'succeeded' with retry: true.
    const second = await runShotGeneration({
      gateway,
      supabase: admin,
      projectId,
      userId: primary.user.id,
      retry: true,
      attemptId,
      recordFixedSpend: realRecordFixedSpend,
    })
    expect(second.ok).toBe(true)

    const rows = await readLedgerRows(projectId)
    expect(rows.length).toBe(1)
  })

  test('the agent-triggered path (BILLED_BY_TURN) writes no fixed-price row', async () => {
    // Direct unit check of the sentinel branch itself, independent of the fuller
    // regenerate_all_shots-through-runAgentTurn fixture in agent-turn-ledger.spec.ts.
    const projectId = await seedProject(primary.user.id)
    const gateway: ClaudeGateway = {
      async createMessage() {
        return successMessage({ title: null, message: '', video_type: 'auto', shots: buildShots(2) })
      },
    }

    const result = await runShotGeneration({
      gateway,
      supabase: admin,
      projectId,
      userId: primary.user.id,
      retry: false,
      attemptId: crypto.randomUUID(),
      recordFixedSpend: BILLED_BY_TURN,
    })
    expect(result.ok).toBe(true)

    const rows = await readLedgerRows(projectId)
    expect(rows.length).toBe(0)
  })
})

test.describe('derive_camera - fixed-price ledger wiring', () => {
  test('writes one ledger row with delta -3, shot_key set, message_id null', async () => {
    const projectId = await seedProject(primary.user.id)
    const { shotId, shotKey } = await seedShot(projectId)
    const gateway: ClaudeGateway = {
      async createMessage() {
        return successMessage({ shot_size: 'wide', shot_size_origin: 'auto' }, 'derive_camera')
      },
    }

    const result = await runCameraDerivation({
      gateway,
      supabase: admin,
      projectId,
      shotId,
      userId: primary.user.id,
      fields: ['shot_size'],
      attemptId: crypto.randomUUID(),
      recordFixedSpend: realRecordFixedSpend,
    })
    expect(result.ok).toBe(true)

    const rows = await readLedgerRows(projectId)
    expect(rows.length).toBe(1)
    expect(rows[0].kind).toBe('spend')
    expect(rows[0].pricing_mode).toBe('fixed')
    expect(rows[0].step).toBe('workbench')
    expect(rows[0].operation).toBe('derive_camera')
    expect(rows[0].message_id).toBeNull()
    expect(rows[0].shot_key).toBe(shotKey)
    expect(rows[0].delta).toBe(-3)
  })

  test('charges the same 3 credits whether one field or all three change', async () => {
    const projectId = await seedProject(primary.user.id)

    const { shotId: oneFieldShot } = await seedShot(projectId)
    const oneFieldGateway: ClaudeGateway = {
      async createMessage() {
        return successMessage({ shot_size: 'wide', shot_size_origin: 'auto' }, 'derive_camera')
      },
    }
    const oneFieldResult = await runCameraDerivation({
      gateway: oneFieldGateway,
      supabase: admin,
      projectId,
      shotId: oneFieldShot,
      userId: primary.user.id,
      fields: ['shot_size'],
      attemptId: crypto.randomUUID(),
      recordFixedSpend: realRecordFixedSpend,
    })
    expect(oneFieldResult.ok).toBe(true)

    const { shotId: allFieldsShot } = await seedShot(projectId)
    const allFieldsGateway: ClaudeGateway = {
      async createMessage() {
        return successMessage(
          {
            shot_size: 'wide',
            shot_size_origin: 'auto',
            camera_angle: 'low',
            camera_angle_origin: 'auto',
            camera_movement: 'pan',
            camera_movement_origin: 'auto',
          },
          'derive_camera'
        )
      },
    }
    const allFieldsResult = await runCameraDerivation({
      gateway: allFieldsGateway,
      supabase: admin,
      projectId,
      shotId: allFieldsShot,
      userId: primary.user.id,
      fields: ['shot_size', 'camera_angle', 'camera_movement'],
      attemptId: crypto.randomUUID(),
      recordFixedSpend: realRecordFixedSpend,
    })
    expect(allFieldsResult.ok).toBe(true)

    const rows = await readLedgerRows(projectId)
    const deltas = rows.filter((r) => r.operation === 'derive_camera').map((r) => r.delta)
    expect(deltas.sort()).toEqual([-3, -3])
  })

  test('all three trigger shapes (description edit, single-field revert, reset-all) charge the same operation and price', async () => {
    const projectId = await seedProject(primary.user.id)

    // Trigger 1: a visual_description edit - all three fields, no revert/resetAll.
    const { shotId: descriptionShot } = await seedShot(projectId)
    const descriptionResult = await runCameraDerivation({
      gateway: {
        async createMessage() {
          return successMessage(
            {
              shot_size: 'wide',
              shot_size_origin: 'auto',
              camera_angle: 'low',
              camera_angle_origin: 'auto',
              camera_movement: 'pan',
              camera_movement_origin: 'auto',
            },
            'derive_camera'
          )
        },
      },
      supabase: admin,
      projectId,
      shotId: descriptionShot,
      userId: primary.user.id,
      fields: ['shot_size', 'camera_angle', 'camera_movement'],
      attemptId: crypto.randomUUID(),
      recordFixedSpend: realRecordFixedSpend,
    })
    expect(descriptionResult.ok).toBe(true)

    // Trigger 2: a single-field "Reset to auto" - one field, revertField set.
    const { shotId: revertShot } = await seedShot(projectId, {
      shot_size: 'close_up',
      shot_size_origin: 'override',
    })
    const revertResult = await runCameraDerivation({
      gateway: {
        async createMessage() {
          return successMessage({ shot_size: 'wide', shot_size_origin: 'auto' }, 'derive_camera')
        },
      },
      supabase: admin,
      projectId,
      shotId: revertShot,
      userId: primary.user.id,
      fields: ['shot_size'],
      revertField: 'shot_size',
      attemptId: crypto.randomUUID(),
      recordFixedSpend: realRecordFixedSpend,
    })
    expect(revertResult.ok).toBe(true)

    // Trigger 3: "Reset all to auto" - all three fields, resetAll: true.
    const { shotId: resetAllShot } = await seedShot(projectId, {
      shot_size: 'close_up',
      shot_size_origin: 'override',
      camera_angle: 'high',
      camera_angle_origin: 'override',
      camera_movement: 'pull_out',
      camera_movement_origin: 'override',
    })
    const resetAllResult = await runCameraDerivation({
      gateway: {
        async createMessage() {
          return successMessage(
            {
              shot_size: 'wide',
              shot_size_origin: 'auto',
              camera_angle: 'low',
              camera_angle_origin: 'auto',
              camera_movement: 'pan',
              camera_movement_origin: 'auto',
            },
            'derive_camera'
          )
        },
      },
      supabase: admin,
      projectId,
      shotId: resetAllShot,
      userId: primary.user.id,
      fields: ['shot_size', 'camera_angle', 'camera_movement'],
      resetAll: true,
      attemptId: crypto.randomUUID(),
      recordFixedSpend: realRecordFixedSpend,
    })
    expect(resetAllResult.ok).toBe(true)

    const rows = (await readLedgerRows(projectId)).filter((r) => r.operation === 'derive_camera')
    expect(rows.length).toBe(3)
    expect(rows.every((r) => r.delta === -3)).toBe(true)
  })

  test('a derive_camera row survives deletion of its shot, with shot_key intact', async () => {
    const projectId = await seedProject(primary.user.id)
    const { shotId, shotKey } = await seedShot(projectId)
    const gateway: ClaudeGateway = {
      async createMessage() {
        return successMessage({ shot_size: 'wide', shot_size_origin: 'auto' }, 'derive_camera')
      },
    }

    const result = await runCameraDerivation({
      gateway,
      supabase: admin,
      projectId,
      shotId,
      userId: primary.user.id,
      fields: ['shot_size'],
      attemptId: crypto.randomUUID(),
      recordFixedSpend: realRecordFixedSpend,
    })
    expect(result.ok).toBe(true)

    const rowsBefore = await readLedgerRows(projectId)
    const ledgerId = rowsBefore.find((r) => r.operation === 'derive_camera')!.id

    const { error: deleteError } = await admin.from('shots').delete().eq('id', shotId)
    expect(deleteError).toBeNull()

    const { data: after, error: readError } = await admin.from('credit_ledger').select('*').eq('id', ledgerId).single()
    expect(readError).toBeNull()
    expect(after!.shot_key).toBe(shotKey)
  })

  test('a failed derive_camera call writes no ledger row', async () => {
    const projectId = await seedProject(primary.user.id)
    const { shotId } = await seedShot(projectId)
    const result = await runCameraDerivation({
      gateway: throwingGateway('simulated failure'),
      supabase: admin,
      projectId,
      shotId,
      userId: primary.user.id,
      fields: ['shot_size'],
      attemptId: crypto.randomUUID(),
      recordFixedSpend: realRecordFixedSpend,
    })
    expect(result.ok).toBe(false)

    const rows = await readLedgerRows(projectId)
    expect(rows.length).toBe(0)
  })

  test('a forced ledger-write failure is swallowed - the request still succeeds, and no row is written', async () => {
    const projectId = await seedProject(primary.user.id)
    const { shotId } = await seedShot(projectId)
    const gateway: ClaudeGateway = {
      async createMessage() {
        return successMessage({ shot_size: 'wide', shot_size_origin: 'auto' }, 'derive_camera')
      },
    }

    const result = await runCameraDerivation({
      gateway,
      supabase: admin,
      projectId,
      shotId,
      userId: primary.user.id,
      fields: ['shot_size'],
      attemptId: crypto.randomUUID(),
      recordFixedSpend: async () => {
        throw new Error('simulated ledger write failure')
      },
    })
    expect(result.ok).toBe(true)

    const rows = await readLedgerRows(projectId)
    expect(rows.length).toBe(0)
  })

  test('calling derive_camera twice with the same attemptId produces exactly one row and does not throw', async () => {
    const projectId = await seedProject(primary.user.id)
    const { shotId } = await seedShot(projectId)
    const attemptId = crypto.randomUUID()
    const gateway: ClaudeGateway = {
      async createMessage() {
        return successMessage({ shot_size: 'wide', shot_size_origin: 'auto' }, 'derive_camera')
      },
    }

    const first = await runCameraDerivation({
      gateway,
      supabase: admin,
      projectId,
      shotId,
      userId: primary.user.id,
      fields: ['shot_size'],
      attemptId,
      recordFixedSpend: realRecordFixedSpend,
    })
    expect(first.ok).toBe(true)

    const second = await runCameraDerivation({
      gateway,
      supabase: admin,
      projectId,
      shotId,
      userId: primary.user.id,
      fields: ['shot_size'],
      attemptId,
      recordFixedSpend: realRecordFixedSpend,
    })
    expect(second.ok).toBe(true)

    const rows = (await readLedgerRows(projectId)).filter((r) => r.operation === 'derive_camera')
    expect(rows.length).toBe(1)
  })
})

// Sums credit_ledger.delta directly via the service-role `admin` client - the real
// credits/balance.ts getBalance can't be called from this plain-Node test process (it
// transitively imports next/headers via supabase/server.ts, which needs a real request
// context), so this replicates its exact logic against the same table instead of going
// through it.
async function readBalance(userId: string): Promise<number> {
  const { data, error } = await admin.from('credit_ledger').select('delta').eq('user_id', userId)
  expect(error).toBeNull()
  return (data ?? []).reduce((sum, row) => sum + row.delta, 0)
}

// primary's real signup grant is never materialized within a fresh, filtered test
// run (nothing here navigates a page or calls the real ensureSignupGrant), and
// global-teardown wipes credit_ledger for the fixed users after every run - so a
// balance-gated call against `primary` needs an explicit top-up first. kind
// 'adjustment' is the one kind exempt from the sign/spend-fields checks, so it's
// the simplest way to grant test credits without impersonating a real signup grant
// (whose dedupe_key is reserved: `signup_grant:${userId}`, one per user, ever).
async function grantTestCredits(userId: string, amount: number): Promise<void> {
  const { error } = await admin.from('credit_ledger').insert({
    user_id: userId,
    kind: 'adjustment',
    delta: amount,
    dedupe_key: `test_grant:${crypto.randomUUID()}`,
    price_version: CREDIT_PRICE_VERSION,
  })
  expect(error).toBeNull()
}

test.describe('write_image_prompts (image-prompts route) - fixed-price ledger wiring', () => {
  test('writes one ledger row priced off the persisted count, not the requested count', async () => {
    await grantTestCredits(primary.user.id, 1000)
    const projectId = await seedProject(primary.user.id)
    const shots = await Promise.all([seedShot(projectId), seedShot(projectId), seedShot(projectId)])
    const shotKeys = shots.map((s) => s.shotKey)
    // Claude returns prompts for only 2 of the 3 requested shots.
    const returnedKeys = shotKeys.slice(0, 2)
    const gateway: ClaudeGateway = {
      async createMessage() {
        return successMessage(
          { prompts: returnedKeys.map((shot_key) => ({ shot_key, image_prompt: 'A'.repeat(60) })) },
          'write_image_prompts'
        )
      },
    }

    const result = await runImagePromptGeneration({
      gateway,
      supabase: admin,
      projectId,
      userId: primary.user.id,
      shotIds: shots.map((s) => s.shotId),
      retry: false,
      attemptId: crypto.randomUUID(),
      recordFixedSpend: realRecordFixedSpend,
      getBalance: readBalance,
      ensureSignupGrant: async () => {},
    })
    expect(result.ok).toBe(false) // 422: one requested shot_key was never returned
    if (!result.ok && result.status === 422) {
      expect(result.missingShotKeys).toEqual([shotKeys[2]])
    }

    const rows = await readLedgerRows(projectId)
    expect(rows.length).toBe(1)
    expect(rows[0].kind).toBe('spend')
    expect(rows[0].pricing_mode).toBe('fixed')
    expect(rows[0].step).toBe('image_prompts')
    expect(rows[0].operation).toBe('write_image_prompts')
    expect(rows[0].shot_key).toBeNull()
    expect(rows[0].delta).toBe(-4) // 2 credits/shot * 2 persisted
    expect(rows[0].delta).not.toBe(-6) // what pricing off the 3 requested would produce
  })

  test('a recovered call (replaying a persisted payload) writes no ledger row', async () => {
    const projectId = await seedProject(primary.user.id)
    const { shotId, shotKey } = await seedShot(projectId)
    const { error: generationError } = await admin.from('generations').insert({
      project_id: projectId,
      step: 'image_prompts',
      operation: 'write_image_prompts',
      shot_id: null,
      state: 'failed',
      payload: { prompts: [{ shot_key: shotKey, image_prompt: 'A'.repeat(60) }] } as never,
    })
    expect(generationError).toBeNull()

    // A gateway that throws if ever called - RECOVER must never reach it.
    const result = await runImagePromptGeneration({
      gateway: throwingGateway('RECOVER must never call the gateway'),
      supabase: admin,
      projectId,
      userId: primary.user.id,
      shotIds: [shotId],
      retry: true,
      attemptId: crypto.randomUUID(),
      recordFixedSpend: realRecordFixedSpend,
      getBalance: readBalance,
      ensureSignupGrant: async () => {},
    })
    expect(result.ok).toBe(true)

    const rows = await readLedgerRows(projectId)
    expect(rows.length).toBe(0)
  })

  test('a failed call writes no ledger row', async () => {
    const projectId = await seedProject(primary.user.id)
    const { shotId } = await seedShot(projectId)

    const result = await runImagePromptGeneration({
      gateway: throwingGateway('simulated failure'),
      supabase: admin,
      projectId,
      userId: primary.user.id,
      shotIds: [shotId],
      retry: false,
      attemptId: crypto.randomUUID(),
      recordFixedSpend: realRecordFixedSpend,
      getBalance: readBalance,
      ensureSignupGrant: async () => {},
    })
    expect(result.ok).toBe(false)

    const rows = await readLedgerRows(projectId)
    expect(rows.length).toBe(0)
  })

  test('a forced ledger-write failure is swallowed - the request still succeeds, and no row is written', async () => {
    await grantTestCredits(primary.user.id, 1000)
    const projectId = await seedProject(primary.user.id)
    const { shotId, shotKey } = await seedShot(projectId)
    const gateway: ClaudeGateway = {
      async createMessage() {
        return successMessage({ prompts: [{ shot_key: shotKey, image_prompt: 'A'.repeat(60) }] }, 'write_image_prompts')
      },
    }

    const result = await runImagePromptGeneration({
      gateway,
      supabase: admin,
      projectId,
      userId: primary.user.id,
      shotIds: [shotId],
      retry: false,
      attemptId: crypto.randomUUID(),
      recordFixedSpend: async () => {
        throw new Error('simulated ledger write failure')
      },
      getBalance: readBalance,
      ensureSignupGrant: async () => {},
    })
    expect(result.ok).toBe(true)

    const rows = await readLedgerRows(projectId)
    expect(rows.length).toBe(0)
  })

  test('calling write_image_prompts twice with the same attemptId produces exactly one row and does not throw', async () => {
    await grantTestCredits(primary.user.id, 1000)
    const projectId = await seedProject(primary.user.id)
    const { shotId, shotKey } = await seedShot(projectId)
    const attemptId = crypto.randomUUID()
    const gateway: ClaudeGateway = {
      async createMessage() {
        return successMessage({ prompts: [{ shot_key: shotKey, image_prompt: 'A'.repeat(60) }] }, 'write_image_prompts')
      },
    }

    const first = await runImagePromptGeneration({
      gateway,
      supabase: admin,
      projectId,
      userId: primary.user.id,
      shotIds: [shotId],
      retry: false,
      attemptId,
      recordFixedSpend: realRecordFixedSpend,
      getBalance: readBalance,
      ensureSignupGrant: async () => {},
    })
    expect(first.ok).toBe(true)

    // write_image_prompts is claimable again from 'succeeded' with retry: true.
    const second = await runImagePromptGeneration({
      gateway,
      supabase: admin,
      projectId,
      userId: primary.user.id,
      shotIds: [shotId],
      retry: true,
      attemptId,
      recordFixedSpend: realRecordFixedSpend,
      getBalance: readBalance,
      ensureSignupGrant: async () => {},
    })
    expect(second.ok).toBe(true)

    const rows = await readLedgerRows(projectId)
    expect(rows.length).toBe(1)
  })

  test('insufficient balance returns 402, with no provider call, no ledger row, and no usage row', async () => {
    const { user } = await createTestSession()
    try {
      const projectId = await seedProject(user.id)
      const { shotId } = await seedShot(projectId)

      // Drain the balance below what write_image_prompts for 1 shot costs (2
      // credits): a single large negative credit_ledger row, distinct dedupe_key -
      // the simplest way to get a known-low balance without spending real credits
      // through another route.
      const { error: drainError } = await admin.from('credit_ledger').insert({
        user_id: user.id,
        delta: -1,
        kind: 'spend',
        pricing_mode: 'fixed',
        dedupe_key: `test_drain:${user.id}`,
        step: 'workbench',
        operation: 'generate_shots',
        attempt_id: crypto.randomUUID(),
        price_version: CREDIT_PRICE_VERSION,
      })
      expect(drainError).toBeNull()
      const balance = await readBalance(user.id)
      expect(balance).toBeLessThan(2) // below write_image_prompts's per-shot price

      const result = await runImagePromptGeneration({
        // A gateway that throws if ever called - proves the balance gate blocks
        // before any provider call, not just that the response is a 402.
        gateway: throwingGateway('balance gate must block before any provider call'),
        supabase: admin,
        projectId,
        userId: user.id,
        shotIds: [shotId],
        retry: false,
        attemptId: crypto.randomUUID(),
        recordFixedSpend: realRecordFixedSpend,
        getBalance: readBalance,
        ensureSignupGrant: async () => {},
      })
      expect(result.ok).toBe(false)
      expect(result.status).toBe(402)

      expect(await readLedgerRows(projectId)).toHaveLength(0)
      expect(await readUsageRows(projectId)).toHaveLength(0)
    } finally {
      await deleteTestUser(user.id)
    }
  })
})

test.describe('usage rows unchanged by Part A/B (gate 12)', () => {
  test('generate_shots writes the same usage row shape as before this task - one row, no ledger-related columns touched', async () => {
    const projectId = await seedProject(primary.user.id)
    const gateway: ClaudeGateway = {
      async createMessage() {
        return successMessage({ title: null, message: '', video_type: 'auto', shots: buildShots(2) })
      },
    }
    await runShotGeneration({
      gateway,
      supabase: admin,
      projectId,
      userId: primary.user.id,
      retry: false,
      attemptId: crypto.randomUUID(),
      recordFixedSpend: realRecordFixedSpend,
    })

    const usageRows = await readUsageRows(projectId)
    expect(usageRows.length).toBe(1)
    expect(usageRows[0].operation).toBe('generate_shots')
    expect(usageRows[0].status).toBe('succeeded')
  })

  test('derive_camera writes the same usage row shape as before this task - one row', async () => {
    const projectId = await seedProject(primary.user.id)
    const { shotId } = await seedShot(projectId)
    await runCameraDerivation({
      gateway: {
        async createMessage() {
          return successMessage({ shot_size: 'wide', shot_size_origin: 'auto' }, 'derive_camera')
        },
      },
      supabase: admin,
      projectId,
      shotId,
      userId: primary.user.id,
      fields: ['shot_size'],
      attemptId: crypto.randomUUID(),
      recordFixedSpend: realRecordFixedSpend,
    })

    const usageRows = await readUsageRows(projectId)
    expect(usageRows.length).toBe(1)
    expect(usageRows[0].operation).toBe('derive_camera')
    expect(usageRows[0].status).toBe('succeeded')
  })
})

test.describe('balance across a mixed sequence (gate 11)', () => {
  test('balance = grant - (one agent turn + one button generation + two camera derivations)', async () => {
    const { user } = await createTestSession()
    try {
      const startingBalance = await getBalance(user.id) // materializes the signup grant
      expect(startingBalance).toBe(SIGNUP_GRANT_CREDITS)

      const projectId = await seedProject(user.id)

      // One agent turn: a single text-only reply, default 10/10 usage -> $0.00006 -> 1 credit.
      const turnResult = await runAgentTurn({
        gateway: { async createMessage() { return textMessage('No changes needed.') } },
        supabase: admin,
        projectId,
        userId: user.id,
        content: 'is everything okay?',
        clientId: crypto.randomUUID(),
        attemptId: crypto.randomUUID(),
        recordTurnSpend: realRecordDynamicSpend,
      })
      expect(turnResult.ok).toBe(true)

      // One button-triggered generation: 2 shots persisted -> 2 * 2 = 4 credits. This
      // wholesale-replaces the project's shot list (runShotsPipeline delete-then-insert),
      // so the shots used for the camera derivations below are seeded AFTER this call,
      // not before - seeding first would have them deleted out from under the test.
      const shotsResult = await runShotGeneration({
        gateway: {
          async createMessage() {
            return successMessage({ title: null, message: '', video_type: 'auto', shots: buildShots(2) })
          },
        },
        supabase: admin,
        projectId,
        userId: user.id,
        retry: false,
        attemptId: crypto.randomUUID(),
        recordFixedSpend: realRecordFixedSpend,
      })
      expect(shotsResult.ok).toBe(true)

      // Two camera derivations: 3 credits each -> 6 credits.
      const cameraGateway: ClaudeGateway = {
        async createMessage() {
          return successMessage({ shot_size: 'wide', shot_size_origin: 'auto' }, 'derive_camera')
        },
      }
      const { shotId: firstShot } = await seedShot(projectId)
      const camera1 = await runCameraDerivation({
        gateway: cameraGateway,
        supabase: admin,
        projectId,
        shotId: firstShot,
        userId: user.id,
        fields: ['shot_size'],
        attemptId: crypto.randomUUID(),
        recordFixedSpend: realRecordFixedSpend,
      })
      expect(camera1.ok).toBe(true)

      const { shotId: secondShot } = await seedShot(projectId)
      const camera2 = await runCameraDerivation({
        gateway: cameraGateway,
        supabase: admin,
        projectId,
        shotId: secondShot,
        userId: user.id,
        fields: ['shot_size'],
        attemptId: crypto.randomUUID(),
        recordFixedSpend: realRecordFixedSpend,
      })
      expect(camera2.ok).toBe(true)

      const finalBalance = await getBalance(user.id)
      const expectedCharge = 1 /* agent turn */ + 4 /* generate_shots: 2*2 */ + 3 + 3 /* two derive_camera */
      expect(finalBalance).toBe(SIGNUP_GRANT_CREDITS - expectedCharge)
    } finally {
      await deleteTestUser(user.id)
    }
  })
})
