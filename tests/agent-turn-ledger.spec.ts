import { test, expect } from '@playwright/test'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { admin, createTestSession, deleteTestUser } from './supabase-test-session'
import { primary } from './fixed-users'
import { stepIndex } from '../src/lib/config/pipeline'
import { SIGNUP_GRANT_CREDITS } from '../src/lib/config/credits'
import { successMessage, textMessage, throwingGateway, scriptedGateway, truncatedMessage } from './helpers/claude-fakes'
import { runAgentTurn } from '../src/app/api/projects/[id]/agent/logic'
import { grantAndReadBalance } from './helpers/ledger-child'
import { getAgentStepConfig } from '../src/app/api/projects/[id]/agent/steps'
import type { recordDynamicSpend } from '../src/lib/credits/ledger'
import type { ClaudeGateway } from '../src/lib/claude'

// src/lib/credits/ledger.ts imports src/lib/supabase/service-role.ts, which imports the
// `server-only` package - directly importing ledger.ts here (plain Node, no
// "react-server" export condition) would throw before ever reaching a ledger function,
// exactly as tests/ledger.spec.ts's own docblock explains. Same fix, reused: spawn a
// short-lived Node child process per call with --conditions=react-server and dynamically
// import() the real .ts source. This is what `realRecordDynamicSpend` below passes to
// runAgentTurn as its `recordTurnSpend` - exercising the actual production
// recordDynamicSpend, not a reimplementation of its rounding/dedupe logic (that's
// ledger.spec.ts's job).
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

const realRecordDynamicSpend: typeof recordDynamicSpend = async (params) => {
  const result = await runLedgerCall('recordDynamicSpend', params)
  if (!result.ok) {
    throw new Error(`recordDynamicSpend failed: ${result.errorName}: ${result.message}`)
  }
}

async function seedProject(userId: string, overrides: Record<string, unknown> = {}) {
  const { data, error } = await admin
    .from('projects')
    .insert({
      user_id: userId,
      title: 'Ledger wiring test',
      source_text: 'A short film for agent-turn ledger wiring tests.',
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

async function seedShot(projectId: string, overrides: Record<string, unknown> = {}) {
  const { data, error } = await admin
    .from('shots')
    .insert({
      project_id: projectId,
      order_index: 0,
      shot_key: `t${crypto.randomUUID().slice(0, 4)}`,
      voice_over: 'Original voiceover.',
      visual_description: 'Original visual description.',
      ...overrides,
    })
    .select('id')
    .single()
  expect(error).toBeNull()
  return data!.id as string
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

async function readUserMessageId(projectId: string) {
  const { data, error } = await admin
    .from('messages')
    .select('id')
    .eq('project_id', projectId)
    .eq('role', 'user')
    .single()
  expect(error).toBeNull()
  return data!.id as string
}

test.describe('runAgentTurn - credit ledger wiring', () => {
  test('a multi-call turn writes exactly one dynamic-spend row, attributed to the turn - not one row per Claude call', async () => {
    const projectId = await seedProject(primary.user.id)
    const shotId = await seedShot(projectId)
    const shotNumber = 1

    const gateway = scriptedGateway([
      successMessage({ shot_number: shotNumber, voice_over: 'First change.' }, 'update_shot'),
      successMessage({ shot_number: shotNumber, voice_over: 'Second change.' }, 'update_shot'),
      textMessage('Made both changes.'),
    ])

    const result = await runAgentTurn({
      config: getAgentStepConfig('workbench'),
      gateway,
      supabase: admin,
      projectId,
      userId: primary.user.id,
      content: 'make two changes',
      clientId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      recordTurnSpend: realRecordDynamicSpend,
    })

    expect(result.ok).toBe(true)
    expect(gateway.getCallCount()).toBe(3)

    // Gate 8: usage rows are exactly what the pre-Task-5 turn would have produced - 3
    // rows (one per Claude call), all operation: 'agent_turn' (no regenerate_all_shots
    // in this turn), the settle-return-value change is additive only.
    const usageRows = await readUsageRows(projectId)
    expect(usageRows.length).toBe(3)
    expect(usageRows.every((r) => r.operation === 'agent_turn')).toBe(true)

    // Gate 3: one ledger row, not one per Claude call.
    const ledgerRows = await readLedgerRows(projectId)
    expect(ledgerRows.length).toBe(1)

    // Gate 1: kind/pricing_mode/step/operation.
    const row = ledgerRows[0]
    expect(row.kind).toBe('spend')
    expect(row.pricing_mode).toBe('dynamic')
    expect(row.step).toBe('workbench')
    expect(row.operation).toBe('agent_turn')

    // Gate 2: message_id is the triggering USER message's id, not the assistant reply's.
    const userMessageId = await readUserMessageId(projectId)
    expect(row.message_id).toBe(userMessageId)
  })

  test('rounds once on the summed total, not once per call - 3 calls at $0.0004/$0.0003/$0.0006 bill 2 credits, not 3', async () => {
    const projectId = await seedProject(primary.user.id)
    const shotId = await seedShot(projectId)

    // Haiku dev rates (src/lib/config/pricing.ts): output $5/1M tokens = $0.000005/tok.
    // 80/60/120 output tokens -> exactly $0.0004 / $0.0003 / $0.0006 per call.
    // Per-call usdToCredits would give ceil(0.4)+ceil(0.3)+ceil(0.6) = 1+1+1 = 3 (each
    // floored up to at least 1 credit). Rounding once on the summed $0.0013 gives
    // ceil(1.3) = 2 - the two methods disagree, which is exactly what this gate checks.
    const usage = (outputTokens: number) => ({
      input_tokens: 0,
      output_tokens: outputTokens,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    })

    const gateway = scriptedGateway([
      successMessage({ shot_number: 1, voice_over: 'v1' }, 'update_shot', usage(80)),
      successMessage({ shot_number: 1, voice_over: 'v2' }, 'update_shot', usage(60)),
      textMessage('Done.', usage(120)),
    ])

    const result = await runAgentTurn({
      config: getAgentStepConfig('workbench'),
      gateway,
      supabase: admin,
      projectId,
      userId: primary.user.id,
      content: 'make a couple small edits',
      clientId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      recordTurnSpend: realRecordDynamicSpend,
    })

    expect(result.ok).toBe(true)
    const ledgerRows = await readLedgerRows(projectId)
    expect(ledgerRows.length).toBe(1)
    expect(ledgerRows[0].delta).toBe(-2)
  })

  // A turn that regenerates the shot list starts the shot chain, and the chain's final run
  // bills the whole action as one dynamic agent_turn row (tests/shot-chain.spec.ts). Here:
  // when the chain has nothing more to write, the turn's own calls and the chain's are
  // still one charge - the turn's cost is handed to the run, never charged on its own.
  test('a turn that regenerates the whole shot list writes no agent_turn row of its own - the chain it started bills the turn once', async () => {
    // Shot lengths are set from the project's video model, which intake always sets.
    const projectId = await seedProject(primary.user.id, { video_model: 'wan-3.0' })
    await seedShot(projectId)
    const usage = (inputTokens: number, outputTokens: number) => ({
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    })
    const gateway = scriptedGateway([
      successMessage({}, 'regenerate_all_shots', usage(969, 600)),
      textMessage('Rewriting the shot list now.', usage(967, 600)),
    ])
    const scheduled: unknown[] = []

    const result = await runAgentTurn({
      config: getAgentStepConfig('workbench'),
      gateway,
      supabase: admin,
      projectId,
      userId: primary.user.id,
      content: 'regenerate all the shots',
      clientId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      recordTurnSpend: realRecordDynamicSpend,
      getBalance: async () => 1_000_000,
      ensureSignupGrant: async () => {},
      shotRuns: { ledger: { recordFixedSpend: async () => {}, recordDynamicSpend: realRecordDynamicSpend }, schedule: (run) => scheduled.push(run) },
    })

    expect(result.ok).toBe(true)
    expect(scheduled).toHaveLength(1)
    // The turn's two calls are recorded; its cost is on the run, waiting for the chain.
    expect((await readUsageRows(projectId)).map((r) => r.operation)).toEqual(['agent_turn', 'agent_turn'])
    expect(await readLedgerRows(projectId)).toHaveLength(0)
    const { data: run } = await admin.from('shot_runs').select('turn_cost_usd, turn_settled_at').eq('project_id', projectId).single()
    expect(Number(run!.turn_cost_usd)).toBeCloseTo(0.003969 + 0.003967, 9)
    expect(run!.turn_settled_at).not.toBeNull()
  })

  test('a turn that fails on its very first call writes no ledger row', async () => {
    const projectId = await seedProject(primary.user.id)

    const result = await runAgentTurn({
      config: getAgentStepConfig('workbench'),
      gateway: throwingGateway('simulated failure'),
      supabase: admin,
      projectId,
      userId: primary.user.id,
      content: 'do something',
      clientId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      recordTurnSpend: realRecordDynamicSpend,
    })

    expect(result.ok).toBe(false)
    expect(await readLedgerRows(projectId)).toEqual([])
  })

  test('a turn that fails AFTER several successful, billable calls also writes no ledger row - real spend already recorded in usage, none in credit_ledger', async () => {
    const projectId = await seedProject(primary.user.id)
    await seedShot(projectId)
    let calls = 0
    const gateway: ClaudeGateway = {
      async createMessage() {
        calls++
        if (calls <= 2) {
          return successMessage({ shot_number: 1, voice_over: `change ${calls}` }, 'update_shot')
        }
        throw new Error('simulated failure after two successful calls')
      },
    }

    const result = await runAgentTurn({
      config: getAgentStepConfig('workbench'),
      gateway,
      supabase: admin,
      projectId,
      userId: primary.user.id,
      content: 'keep making changes',
      clientId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      recordTurnSpend: realRecordDynamicSpend,
    })

    expect(result.ok).toBe(false)
    expect(calls).toBe(3)
    // Two calls really were billed and settled into usage (real Anthropic cost, per
    // the current single-funnel try/catch/finally - see the report), but the turn as a
    // whole still failed, so no credit_ledger row exists - the same "no partial
    // charge" outcome as failing on the first call.
    const usageRows = await readUsageRows(projectId)
    expect(usageRows.length).toBe(3)
    expect(usageRows.filter((r) => r.status === 'succeeded').length).toBe(2)
    expect(await readLedgerRows(projectId)).toEqual([])
  })

  test('a forced ledger-write failure is logged and swallowed - the turn still returns its result to the user', async () => {
    const projectId = await seedProject(primary.user.id)

    const result = await runAgentTurn({
      config: getAgentStepConfig('workbench'),
      gateway: scriptedGateway([textMessage('Just a quick reply.')]),
      supabase: admin,
      projectId,
      userId: primary.user.id,
      content: 'say hello',
      clientId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      recordTurnSpend: async () => {
        throw new Error('simulated ledger write failure')
      },
    })

    // The request is not failed by the ledger write throwing.
    expect(result.ok).toBe(true)
    expect(await readLedgerRows(projectId)).toEqual([])
    // usage is entirely unaffected by the ledger write failing.
    const usageRows = await readUsageRows(projectId)
    expect(usageRows.length).toBe(1)
    expect(usageRows[0].status).toBe('succeeded')
  })

  test('balance after a turn equals the signup grant minus the turn\'s real charge', async () => {
    const { user } = await createTestSession()
    try {
      // Grants the signup credits to this brand-new user through the real
      // ensureSignupGrant (the layout does it on page load; a plain-Node test has none).
      const startingBalance = await grantAndReadBalance(user.id)
      expect(startingBalance).toBe(SIGNUP_GRANT_CREDITS)

      const projectId = await seedProject(user.id)
      // Default (10 input / 10 output token) usage -> $0.00001 + $0.00005 = $0.00006 ->
      // usdToCredits floors any nonzero amount up to at least 1 credit -> 1 credit.
      const result = await runAgentTurn({
        config: getAgentStepConfig('workbench'),
        gateway: scriptedGateway([textMessage('Hi there.')]),
        supabase: admin,
        projectId,
        userId: user.id,
        content: 'hello',
        clientId: crypto.randomUUID(),
        attemptId: crypto.randomUUID(),
        recordTurnSpend: realRecordDynamicSpend,
      })
      expect(result.ok).toBe(true)

      const ledgerRows = await readLedgerRows(projectId)
      expect(ledgerRows.length).toBe(1)
      expect(ledgerRows[0].delta).toBe(-1)

      const endingBalance = await grantAndReadBalance(user.id)
      expect(endingBalance).toBe(SIGNUP_GRANT_CREDITS - 1)
    } finally {
      await deleteTestUser(user.id)
    }
  })
})
