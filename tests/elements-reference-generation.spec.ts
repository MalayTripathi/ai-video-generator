import { test, expect } from '@playwright/test'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { admin, createTestSession, deleteTestUser } from './supabase-test-session'
import { primary } from './fixed-users'
import { stepIndex } from '../src/lib/config/pipeline'
import { successImageGateway, throwingImageGateway } from './helpers/openai-fakes'
import { runElementReferenceGeneration } from '../src/app/api/projects/[id]/elements/[elementId]/reference/generate/logic'
import type { recordFixedSpend } from '../src/lib/credits/ledger'
import type { getBalance as getBalanceType } from '../src/lib/credits/balance'
import type { ensureSignupGrant as ensureSignupGrantType } from '../src/lib/credits/signup-grant'
import { SIGNUP_GRANT_CREDITS } from '../src/lib/config/credits'

// Same child-process dispatcher as tests/fixed-price-ledger.spec.ts / tests/ledger.spec.ts
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

// getBalance (credits/balance.ts) is a pure read on the ordinary, cookie-scoped
// Supabase client - it has no service-role dependency to dodge, but it also can't run
// outside a real Next.js request (next/headers's cookies() needs that context, which
// a bare Node child process doesn't have). runElementReferenceGeneration only ever
// calls it through this injected param, so the fake below reads the same rows the
// real implementation would, directly via the admin client already used to seed and
// assert on these tests.
const realGetBalance: typeof getBalanceType = async (userId) => {
  const { data, error } = await admin.from('credit_ledger').select('delta').eq('user_id', userId)
  if (error) {
    throw new Error(`getBalance failed: ${error.message}`)
  }
  return data.reduce((sum, row) => sum + row.delta, 0)
}

// ensureSignupGrant (credits/signup-grant.ts) is service-role and would need the same
// child-process dispatch as recordFixedSpend, but these tests don't need real
// concurrency coverage of it (that's ledger.spec.ts's job) - just its effect, so a
// fake that mirrors its idempotent insert-if-missing semantics via the admin client
// is enough.
const realEnsureSignupGrant: typeof ensureSignupGrantType = async (userId) => {
  const { data: existing } = await admin
    .from('credit_ledger')
    .select('id')
    .eq('user_id', userId)
    .eq('dedupe_key', `signup_grant:${userId}`)
    .maybeSingle()
  if (existing) return

  await admin.from('credit_ledger').insert({
    user_id: userId,
    kind: 'signup_grant',
    delta: SIGNUP_GRANT_CREDITS,
    dedupe_key: `signup_grant:${userId}`,
    price_version: 'test',
  })
}

async function seedProject(userId: string, overrides: Record<string, unknown> = {}) {
  const { data, error } = await admin
    .from('projects')
    .insert({
      user_id: userId,
      title: 'Element reference generation test',
      source_text: 'A short film for element-reference-generation tests.',
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

async function seedElement(projectId: string, overrides: Record<string, unknown> = {}) {
  const { data, error } = await admin
    .from('elements')
    .insert({ project_id: projectId, name: `Element ${crypto.randomUUID()}`, type: 'character', ...overrides })
    .select('id')
    .single()
  expect(error).toBeNull()
  return data!.id as string
}

async function seedShot(projectId: string, overrides: Record<string, unknown> = {}) {
  const { data, error } = await admin
    .from('shots')
    .insert({
      project_id: projectId,
      order_index: 0,
      shot_key: `t${Math.random().toString(36).slice(2, 6)}`,
      voice_over: 'Placeholder voice-over.',
      ...overrides,
    })
    .select('id')
    .single()
  expect(error).toBeNull()
  return data!.id as string
}

async function imagePromptStale(shotId: string): Promise<boolean> {
  const { data, error } = await admin.from('shots').select('image_prompt_stale').eq('id', shotId).single()
  expect(error).toBeNull()
  return data!.image_prompt_stale
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

async function readGeneration(projectId: string, elementId: string) {
  const { data, error } = await admin
    .from('generations')
    .select('error')
    .eq('project_id', projectId)
    .eq('operation', 'generate_element_reference')
    .eq('element_id', elementId)
    .single()
  expect(error).toBeNull()
  return data!
}

async function readElement(elementId: string) {
  const { data, error } = await admin
    .from('elements')
    .select('reference_image_path, status')
    .eq('id', elementId)
    .single()
  expect(error).toBeNull()
  return data!
}

async function listObjectsUnder(userId: string, projectId: string, elementId: string) {
  const { data, error } = await admin.storage.from('artifacts').list(`${userId}/${projectId}/elements/${elementId}`)
  expect(error).toBeNull()
  return data ?? []
}

/** Drains a fresh test user's balance down to `remaining` credits via a synthetic
 * spend row - a fresh createTestSession() user has no ledger rows until granted, so
 * this seeds the grant first (getBalance no longer does that lazily - see
 * realEnsureSignupGrant above), then drains it. A deliberate, isolated drain rather
 * than sharing primary's balance (which every other spec's fixed user also spends
 * against). */
async function drainBalanceTo(userId: string, remaining: number): Promise<void> {
  await realEnsureSignupGrant(userId)
  const balance = await realGetBalance(userId)
  const { error } = await admin.from('credit_ledger').insert({
    user_id: userId,
    kind: 'spend',
    delta: -(balance - remaining),
    step: 'workbench',
    operation: 'generate_shots',
    attempt_id: crypto.randomUUID(),
    dedupe_key: `test-drain:${crypto.randomUUID()}`,
    price_version: 'test',
    pricing_mode: 'fixed',
  })
  expect(error).toBeNull()
}

test.describe('generate_element_reference - balance gate', () => {
  test('insufficient balance returns 402 and never calls the provider', async () => {
    const { user } = await createTestSession()
    try {
      await drainBalanceTo(user.id, 1) // generate_element_reference costs more than 1
      const projectId = await seedProject(user.id)
      const elementId = await seedElement(projectId)
      const gateway = successImageGateway()

      const result = await runElementReferenceGeneration({
        gateway,
        supabase: admin,
        projectId,
        elementId,
        userId: user.id,
        attemptId: crypto.randomUUID(),
        recordFixedSpend: realRecordFixedSpend,
        getBalance: realGetBalance,
        ensureSignupGrant: realEnsureSignupGrant,
      })

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.status).toBe(402)
      expect(gateway.getCallCount()).toBe(0)

      const usageRows = await readUsageRows(projectId)
      expect(usageRows.length).toBe(0)
      const ledgerRows = await readLedgerRows(projectId)
      expect(ledgerRows.length).toBe(0)
    } finally {
      await deleteTestUser(user.id)
    }
  })
})

test.describe('generate_element_reference - one call, no retry', () => {
  test('a successful generation calls the provider exactly once', async () => {
    const projectId = await seedProject(primary.user.id)
    const elementId = await seedElement(projectId)
    const gateway = successImageGateway()

    const result = await runElementReferenceGeneration({
      gateway,
      supabase: admin,
      projectId,
      elementId,
      userId: primary.user.id,
      attemptId: crypto.randomUUID(),
      recordFixedSpend: realRecordFixedSpend,
      getBalance: realGetBalance,
      ensureSignupGrant: realEnsureSignupGrant,
    })

    expect(result.ok).toBe(true)
    expect(gateway.getCallCount()).toBe(1)
  })

  test('a failed call surfaces the failure, calls the provider exactly once, and writes no ledger row', async () => {
    const projectId = await seedProject(primary.user.id)
    const elementId = await seedElement(projectId)
    const gateway = throwingImageGateway('simulated OpenAI failure')

    const result = await runElementReferenceGeneration({
      gateway,
      supabase: admin,
      projectId,
      elementId,
      userId: primary.user.id,
      attemptId: crypto.randomUUID(),
      recordFixedSpend: realRecordFixedSpend,
      getBalance: realGetBalance,
      ensureSignupGrant: realEnsureSignupGrant,
    })

    expect(result.ok).toBe(false)
    expect(gateway.getCallCount()).toBe(1)

    const ledgerRows = await readLedgerRows(projectId)
    expect(ledgerRows.length).toBe(0)

    // usage still settles (not stuck pending) even though the action failed - the two
    // tables answer different questions and stay independent.
    const usageRows = await readUsageRows(projectId)
    expect(usageRows.length).toBe(1)
    expect(usageRows[0].status).not.toBe('pending')

    const element = await readElement(elementId)
    expect(element.status).toBe('failed')
    expect(element.reference_image_path).toBeNull()
  })

  test('a classified failure (blocked or generic) writes the raw diagnostic text to generations.error and usage, never the mapped copy the client sees', async () => {
    const projectId = await seedProject(primary.user.id)
    const elementId = await seedElement(projectId)
    const gateway = throwingImageGateway('simulated OpenAI failure: rate limited')

    const result = await runElementReferenceGeneration({
      gateway,
      supabase: admin,
      projectId,
      elementId,
      userId: primary.user.id,
      attemptId: crypto.randomUUID(),
      recordFixedSpend: realRecordFixedSpend,
      getBalance: realGetBalance,
      ensureSignupGrant: realEnsureSignupGrant,
    })

    expect(result.ok).toBe(false)
    // result.error (what runElementReferenceGeneration itself returns) is the raw
    // text too - mapping to safe, fixed copy is route.ts's job alone, never logic.ts's.
    if (!result.ok) expect(result.error).toContain('simulated OpenAI failure: rate limited')

    const generation = await readGeneration(projectId, elementId)
    expect(generation.error).toContain('simulated OpenAI failure: rate limited')

    const usageRows = await readUsageRows(projectId)
    expect(usageRows.length).toBe(1)
    expect(JSON.stringify(usageRows[0].raw_usage)).toContain('simulated OpenAI failure: rate limited')
  })
})

test.describe('generate_element_reference - success', () => {
  test('writes one ledger row, one settled usage row, and marks the element ready', async () => {
    const projectId = await seedProject(primary.user.id)
    const elementId = await seedElement(projectId)
    const gateway = successImageGateway()

    const result = await runElementReferenceGeneration({
      gateway,
      supabase: admin,
      projectId,
      elementId,
      userId: primary.user.id,
      attemptId: crypto.randomUUID(),
      recordFixedSpend: realRecordFixedSpend,
      getBalance: realGetBalance,
      ensureSignupGrant: realEnsureSignupGrant,
    })

    expect(result.ok).toBe(true)

    const ledgerRows = await readLedgerRows(projectId)
    expect(ledgerRows.length).toBe(1)
    expect(ledgerRows[0].kind).toBe('spend')
    expect(ledgerRows[0].pricing_mode).toBe('fixed')
    expect(ledgerRows[0].step).toBe('workbench')
    expect(ledgerRows[0].operation).toBe('generate_element_reference')

    const usageRows = await readUsageRows(projectId)
    expect(usageRows.length).toBe(1)
    expect(usageRows[0].status).toBe('succeeded')
    expect(usageRows[0].provider).toBe('openai')

    const element = await readElement(elementId)
    expect(element.status).toBe('ready')
    expect(element.reference_image_path).not.toBeNull()
  })
})

test.describe('generate_element_reference - image-prompt staleness', () => {
  test('a successful generation marks bound shots image-prompt stale, leaving unbound shots untouched', async () => {
    const projectId = await seedProject(primary.user.id)
    const elementId = await seedElement(projectId)
    const bound = await seedShot(projectId, { order_index: 0 })
    const unbound = await seedShot(projectId, { order_index: 1 })
    await admin.from('shot_elements').insert({ shot_id: bound, element_id: elementId })

    const result = await runElementReferenceGeneration({
      gateway: successImageGateway(),
      supabase: admin,
      projectId,
      elementId,
      userId: primary.user.id,
      attemptId: crypto.randomUUID(),
      recordFixedSpend: realRecordFixedSpend,
      getBalance: realGetBalance,
      ensureSignupGrant: realEnsureSignupGrant,
    })

    expect(result.ok).toBe(true)
    expect(await imagePromptStale(bound)).toBe(true)
    expect(await imagePromptStale(unbound)).toBe(false)
  })

  test('generating a reference for the style element marks every shot in the project stale', async () => {
    const projectId = await seedProject(primary.user.id)
    const styleId = await seedElement(projectId, { name: 'Project Style', type: 'style' })
    const shot1 = await seedShot(projectId, { order_index: 0 })
    const shot2 = await seedShot(projectId, { order_index: 1 })

    const result = await runElementReferenceGeneration({
      gateway: successImageGateway(),
      supabase: admin,
      projectId,
      elementId: styleId,
      userId: primary.user.id,
      attemptId: crypto.randomUUID(),
      recordFixedSpend: realRecordFixedSpend,
      getBalance: realGetBalance,
      ensureSignupGrant: realEnsureSignupGrant,
    })

    expect(result.ok).toBe(true)
    expect(await imagePromptStale(shot1)).toBe(true)
    expect(await imagePromptStale(shot2)).toBe(true)
  })
})

test.describe('generate_element_reference - recovery', () => {
  test('a replayed claim (payload already present) never calls the provider again', async () => {
    const projectId = await seedProject(primary.user.id)
    const elementId = await seedElement(projectId)
    const bound = await seedShot(projectId, { order_index: 0 })
    await admin.from('shot_elements').insert({ shot_id: bound, element_id: elementId })

    const { error: generationError } = await admin.from('generations').insert({
      project_id: projectId,
      step: 'workbench',
      operation: 'generate_element_reference',
      shot_id: null,
      element_id: elementId,
      state: 'failed',
      payload: { path: `${primary.user.id}/${projectId}/elements/${elementId}/preexisting.webp` } as never,
    })
    expect(generationError).toBeNull()

    // Seed the object the stored payload claims exists, so the relink step has a real
    // object to point at.
    const { error: uploadError } = await admin.storage
      .from('artifacts')
      .upload(
        `${primary.user.id}/${projectId}/elements/${elementId}/preexisting.webp`,
        Buffer.from('fake-recovered-bytes'),
        { contentType: 'image/webp', upsert: true }
      )
    expect(uploadError).toBeNull()

    const gateway = throwingImageGateway('RECOVER must never call the provider')

    const result = await runElementReferenceGeneration({
      gateway,
      supabase: admin,
      projectId,
      elementId,
      userId: primary.user.id,
      attemptId: crypto.randomUUID(),
      recordFixedSpend: realRecordFixedSpend,
      getBalance: realGetBalance,
      ensureSignupGrant: realEnsureSignupGrant,
    })

    expect(result.ok).toBe(true)
    expect(gateway.getCallCount()).toBe(0)

    // RECOVER spends nothing - no usage row, no ledger row.
    expect((await readUsageRows(projectId)).length).toBe(0)
    expect((await readLedgerRows(projectId)).length).toBe(0)

    const element = await readElement(elementId)
    expect(element.status).toBe('ready')
    expect(await imagePromptStale(bound)).toBe(true)
  })
})

test.describe('generate_element_reference - regeneration', () => {
  test('a previously-succeeded element can be regenerated, replacing the object and charging again', async () => {
    const projectId = await seedProject(primary.user.id)
    const elementId = await seedElement(projectId)

    const first = await runElementReferenceGeneration({
      gateway: successImageGateway(),
      supabase: admin,
      projectId,
      elementId,
      userId: primary.user.id,
      attemptId: crypto.randomUUID(),
      recordFixedSpend: realRecordFixedSpend,
      getBalance: realGetBalance,
      ensureSignupGrant: realEnsureSignupGrant,
    })
    expect(first.ok).toBe(true)
    const firstPath = first.ok ? first.data.path : null

    // OPERATION_POLICY['generate_element_reference'] is claimableFrom: {succeeded:
    // 'always', failed: 'always'} - no retry flag needed, this just works.
    const second = await runElementReferenceGeneration({
      gateway: successImageGateway(),
      supabase: admin,
      projectId,
      elementId,
      userId: primary.user.id,
      attemptId: crypto.randomUUID(),
      recordFixedSpend: realRecordFixedSpend,
      getBalance: realGetBalance,
      ensureSignupGrant: realEnsureSignupGrant,
    })
    expect(second.ok).toBe(true)
    const secondPath = second.ok ? second.data.path : null

    expect(secondPath).not.toBe(firstPath)

    const element = await readElement(elementId)
    expect(element.reference_image_path).toBe(secondPath)

    const objects = await listObjectsUnder(primary.user.id, projectId, elementId)
    expect(objects.length).toBe(1) // old object removed, only the new one remains

    const ledgerRows = await readLedgerRows(projectId)
    expect(ledgerRows.length).toBe(2) // charged twice, once per generation
  })
})

test.describe('generate_element_reference - independent per-element claims', () => {
  test('two elements in the same project generate independently', async () => {
    const projectId = await seedProject(primary.user.id)
    const elementA = await seedElement(projectId)
    const elementB = await seedElement(projectId)

    const [resultA, resultB] = await Promise.all([
      runElementReferenceGeneration({
        gateway: successImageGateway(),
        supabase: admin,
        projectId,
        elementId: elementA,
        userId: primary.user.id,
        attemptId: crypto.randomUUID(),
        recordFixedSpend: realRecordFixedSpend,
        getBalance: realGetBalance,
        ensureSignupGrant: realEnsureSignupGrant,
      }),
      runElementReferenceGeneration({
        gateway: successImageGateway(),
        supabase: admin,
        projectId,
        elementId: elementB,
        userId: primary.user.id,
        attemptId: crypto.randomUUID(),
        recordFixedSpend: realRecordFixedSpend,
        getBalance: realGetBalance,
        ensureSignupGrant: realEnsureSignupGrant,
      }),
    ])

    expect(resultA.ok).toBe(true)
    expect(resultB.ok).toBe(true)

    const elA = await readElement(elementA)
    const elB = await readElement(elementB)
    expect(elA.status).toBe('ready')
    expect(elB.status).toBe('ready')
    expect(elA.reference_image_path).not.toBe(elB.reference_image_path)

    const ledgerRows = await readLedgerRows(projectId)
    expect(ledgerRows.length).toBe(2)
  })
})
