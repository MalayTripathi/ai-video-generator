import { test, expect } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'
import { admin, createTestSession, deleteTestUser, createFreshUser } from './supabase-test-session'
import {
  NO_LEDGER,
  REAL_SHOT_LEDGER,
  chainGateway,
  fakeOutline,
  fakeShot,
  holdLedger,
  insertChainProject,
  readChainShots,
  readRun,
  runChain,
} from './helpers/shot-chain'
import { throwingGateway } from './helpers/claude-fakes'
import { runShotsRequest } from '../src/app/api/projects/[id]/shots/logic'
import { placeHold, settleHold } from '../src/lib/credits/ledger'
import { holdAndSettle, readBalance } from '../src/lib/credits/balance'
import { readSettledBalance } from '../src/lib/credits/release-stale-holds'
import { shotGenerationCredits, InsufficientCreditsError } from '../src/lib/config/credits'
import { finishShotRun } from '../src/lib/shots/runs'
import { aggregateCreditsPeriod } from '../src/app/(app)/credits/aggregate'
import { readLedgerGroups } from '../src/app/(app)/credits/data'

// Layer: api. Shot generation's credits: one hold at the start, atomic with its balance
// check, and exactly one settle at the end - a refund of the unused hold or one extra spend -
// on every way a run ends, including a chain that died and whose project is never opened
// again. Users whose balance a test reads or drains exactly are fresh (createTestSession),
// never the shared fixed users.

/** Sets a fresh user's real balance to exactly `credits` (an adjustment row). */
async function setBalance(userId: string, credits: number) {
  const { data } = await admin.from('credit_balances').select('balance').eq('user_id', userId).maybeSingle()
  const delta = credits - (data?.balance ?? 0)
  if (delta === 0) return
  const { error } = await admin.from('credit_ledger').insert({
    user_id: userId,
    kind: 'adjustment',
    delta,
    step: null,
    operation: null,
    project_id: null,
    message_id: null,
    shot_key: null,
    attempt_id: null,
    dedupe_key: `test_balance:${crypto.randomUUID()}`,
    price_version: 'test',
    pricing_mode: null,
    refunds_ledger_id: null,
  })
  expect(error).toBeNull()
}

async function balanceOf(userId: string) {
  return (await readBalance(admin, userId, { fresh: true })).balance
}

/** A client that counts its requests - to prove the normal balance read is one query. */
function countingClient() {
  let requests = 0
  const client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: {
      fetch: (input, init) => {
        requests += 1
        return fetch(input, init)
      },
    },
  })
  return { client, count: () => requests }
}

const onePerScene = () =>
  chainGateway({
    outline: fakeOutline([{ title: 'A', seconds: 20 }, { title: 'B', seconds: 25 }]),
    chunk: (ask) => ({ shots: [1, 2].map((i) => fakeShot(`h${ask.scenePosition}i${i} spoken words here`)), scene_complete: true }),
  })


// Each test owns a fresh user: these chains spend heavily, and neither the shared fixed user's
// monthly spend cap nor its balance may decide their outcome.
let owner: { id: string }
test.beforeEach(async () => {
  owner = await createFreshUser()
})
test.afterEach(async () => {
  await deleteTestUser(owner.id)
})

test.describe('shot holds - the start', () => {
  test('a balance below the quote refuses the start: 402, no hold, no claim, no run', async () => {
    const { user } = await createTestSession()
    try {
      await setBalance(user.id, shotGenerationCredits('30-60s') - 1)
      const projectId = await insertChainProject(user.id, { duration_target: '30-60s' })
      // The cheap pre-check is passed a stale, generous figure: the hold's own read refuses.
      const { request } = await runChain({ projectId, userId: user.id, gateway: throwingGateway('never'), ledger: REAL_SHOT_LEDGER, topUp: false })
      expect(request).toMatchObject({ ok: false, status: 402, requiredCredits: shotGenerationCredits('30-60s') })
      expect((await holdLedger(projectId)).rows).toHaveLength(0)
      expect((await admin.from('generations').select('id').eq('project_id', projectId)).data).toEqual([])
      expect((await admin.from('shot_runs').select('id').eq('project_id', projectId)).data).toEqual([])
    } finally {
      await deleteTestUser(user.id)
    }
  })

  test('two concurrent starts against a balance that covers one: exactly one passes', { tag: '@smoke' }, async () => {
    const { user } = await createTestSession()
    try {
      const quote = shotGenerationCredits('30-60s')
      await setBalance(user.id, quote)
      const [a, b] = await Promise.all([
        insertChainProject(user.id, { duration_target: '30-60s' }),
        insertChainProject(user.id, { duration_target: '30-60s' }),
      ])
      const start = (projectId: string) =>
        runShotsRequest({
          supabase: admin,
          projectId,
          userId: user.id,
          mode: 'generate',
          retry: false,
          attemptId: crypto.randomUUID(),
          getBalance: async () => quote, // both see enough before the hold
          ensureSignupGrant: async () => {},
          ledger: REAL_SHOT_LEDGER,
        })
      const results = await Promise.all([start(a), start(b)])
      expect(results.filter((r) => r.ok)).toHaveLength(1)
      expect(results.filter((r) => !r.ok && r.status === 402)).toHaveLength(1)
      expect(await balanceOf(user.id)).toBe(0)

      // The slot counter serializes any number of placers, across projects and operations.
      await setBalance(user.id, quote)
      const placed = await Promise.allSettled(
        Array.from({ length: 5 }, () =>
          placeHold({
            userId: user.id,
            credits: quote,
            attemptId: crypto.randomUUID(),
            step: 'workbench',
            operation: 'generate_shots',
            pricingMode: 'fixed',
            projectId: a,
          })
        )
      )
      expect(placed.filter((p) => p.status === 'fulfilled')).toHaveLength(1)
      for (const p of placed.filter((p): p is PromiseRejectedResult => p.status === 'rejected')) {
        expect(p.reason).toBeInstanceOf(InsufficientCreditsError)
      }
      expect(await balanceOf(user.id)).toBe(0)
    } finally {
      await deleteTestUser(user.id)
    }
  })

  test('a hold that cannot be written refuses the start with nothing begun: 500, no claim, no run', async () => {
    const projectId = await insertChainProject(owner.id, { duration_target: '30-60s' })
    const { request } = await runChain({
      projectId,
      userId: owner.id,
      gateway: throwingGateway('never'),
      ledger: {
        placeHold: async () => {
          throw new Error('simulated hold write failure')
        },
        settleHold: NO_LEDGER.settleHold,
      },
    })
    expect(request).toMatchObject({ ok: false, status: 500 })
    expect((await admin.from('generations').select('id').eq('project_id', projectId)).data).toEqual([])
    expect((await admin.from('shot_runs').select('id').eq('project_id', projectId)).data).toEqual([])
  })
})

test.describe('shot holds - the settle', () => {
  test('exactly one settle per hold: a second settle writes nothing', async () => {
    const projectId = await insertChainProject(owner.id, { duration_target: '1-2min' })
    const { request } = await runChain({ projectId, userId: owner.id, gateway: onePerScene(), ledger: REAL_SHOT_LEDGER })
    const run = await readRun((request as { runId: string }).runId)
    const target = {
      userId: owner.id,
      attemptId: run.attempt_id,
      step: 'workbench' as const,
      operation: 'generate_shots' as const,
      pricingMode: 'fixed' as const,
      projectId,
    }
    expect(await settleHold({ ...target, actualCredits: 8 })).toBe('already_settled')
    expect(await settleHold({ ...target, actualCredits: 999 })).toBe('already_settled')
    const ledger = await holdLedger(projectId)
    expect(ledger.settles).toHaveLength(1)
    expect(ledger.net).toBe(8)
    // The run end shows the hold and the actual charge.
    expect(holdAndSettle(ledger.rows)).toEqual({ held: shotGenerationCredits('1-2min'), charged: 8 })
  })

  test('a cancelled run releases its hold at what it saved', async () => {
    const projectId = await insertChainProject(owner.id, { duration_target: '30-60s' })
    const { request } = await runChain({ projectId, userId: owner.id, gateway: onePerScene(), ledger: REAL_SHOT_LEDGER, handOff: () => 'drop', runBudgetMs: 0 })
    const runId = (request as { runId: string }).runId
    // The outline run handed off and nothing ran after it: cancel it.
    await finishShotRun(admin, REAL_SHOT_LEDGER, runId, { status: 'failed', stopReason: 'error' })
    const ledger = await holdLedger(projectId)
    expect(ledger.settles).toHaveLength(1)
    expect(ledger.net).toBe(0)
  })
})

test.describe('shot holds - dead runs are released per user', () => {
  test('an abandoned run whose project is never reopened: the next balance read past the stale window releases its hold', async () => {
    test.setTimeout(60_000)
    const { user } = await createTestSession()
    try {
      await setBalance(user.id, 1_000)
      const projectId = await insertChainProject(user.id, { duration_target: '30-60s' })
      // Scene A is written, then the chain dies (its hand-off is accepted but never runs).
      const slow = chainGateway({
        outline: fakeOutline([{ title: 'A', seconds: 20 }, { title: 'B', seconds: 25 }]),
        delayMs: 4_500,
        chunk: () => ({ shots: [1, 2, 3].map((i) => fakeShot(`d${i} spoken words here`)), scene_complete: true }),
      })
      const { request } = await runChain({
        projectId,
        userId: user.id,
        gateway: slow,
        ledger: REAL_SHOT_LEDGER,
        topUp: false,
        concurrency: 1,
        runBudgetMs: 4_000,
        handOff: () => 'drop',
      })
      const runId = (request as { runId: string }).runId
      expect((await readRun(runId)).status).toBe('running')
      const held = shotGenerationCredits('30-60s')
      expect(await balanceOf(user.id)).toBe(1_000 - held)

      // A live run's hold is never released by a balance read.
      const live = await readSettledBalance(admin, user.id)
      expect(live.balance).toBe(1_000 - held)
      expect((await holdLedger(projectId)).settles).toHaveLength(0)

      // Past the stale window. The project is never touched again - only a balance read.
      const old = new Date(Date.now() - 10 * 60_000).toISOString()
      await admin.from('shot_runs').update({ heartbeat_at: old }).eq('id', runId)
      const released = await readSettledBalance(admin, user.id)
      const saved = (await readChainShots(projectId)).length
      expect(saved).toBe(3)
      expect(released.balance).toBe(1_000 - 2 * saved)
      const ledger = await holdLedger(projectId)
      expect(ledger.settles).toHaveLength(1)
      expect(ledger.settles[0]).toMatchObject({ kind: 'refund' })
      expect(released.openHoldLiveAt).toBeNull()
    } finally {
      await deleteTestUser(user.id)
    }
  })

  test('with no open hold, the balance read is exactly one query', async () => {
    const projectId = await insertChainProject(owner.id, { duration_target: '30-60s' })
    await runChain({ projectId, userId: owner.id, gateway: onePerScene(), ledger: REAL_SHOT_LEDGER })
    const { client, count } = countingClient()
    const read = await readSettledBalance(client, owner.id)
    expect(read.openHoldLiveAt).toBeNull()
    expect(count()).toBe(1)
  })
})

test.describe('shot holds - every figure shows the net charge', () => {
  test('/credits and the rail net a hold and its refund to the actual charge - never the hold', () => {
    const rows = [
      { kind: 'signup_grant', step: null, operation: null, project_id: null, delta: 5000 },
      { kind: 'spend', step: 'workbench' as const, operation: 'generate_shots' as const, project_id: 'p1', delta: -72, entries: 1 },
      { kind: 'refund', step: 'workbench' as const, operation: 'generate_shots' as const, project_id: 'p1', delta: 10, entries: 1 },
      { kind: 'spend', step: 'workbench' as const, operation: 'agent_turn' as const, project_id: 'p1', delta: -16, entries: 1 },
      { kind: 'refund', step: 'workbench' as const, operation: 'agent_turn' as const, project_id: 'p1', delta: 13, entries: 1 },
    ]
    const result = aggregateCreditsPeriod(rows, [{ id: 'p1', title: 'P', source_text: null, video_type: null, duration_target: '3-5min' }])
    expect(result.spentThisPeriod).toBe(62 + 3)
    expect(result.byProject[0].total).toBe(65)
    const shotsRow = result.byStep[0].operations.find((o) => o.operation === 'generate_shots')!
    expect(shotsRow.credits).toBe(62)
  })
})

test.describe('shot holds - /credits counts actions by their hold', () => {
  test('a run settled with a refund and one settled with an excess spend are two generations, not four', async () => {
    const { user } = await createTestSession()
    try {
      await setBalance(user.id, 10_000)
      // Run 1 saves 4 shots against a 16-credit hold (refund 8). Run 2 saves 16 shots against
      // a 16-credit hold (excess spend 16).
      const under = await insertChainProject(user.id, { duration_target: '30-60s' })
      await runChain({ projectId: under, userId: user.id, gateway: onePerScene(), ledger: REAL_SHOT_LEDGER, topUp: false })
      const over = await insertChainProject(user.id, { duration_target: '30-60s' })
      const long = chainGateway({
        outline: fakeOutline([{ title: 'A', seconds: 20 }, { title: 'B', seconds: 25 }]),
        chunk: (ask) => ({ shots: Array.from({ length: 8 }, (_, i) => fakeShot(`x${ask.scenePosition}i${i}`)), scene_complete: true }),
      })
      await runChain({ projectId: over, userId: user.id, gateway: long, ledger: REAL_SHOT_LEDGER, topUp: false })
      expect((await holdLedger(under)).settles[0]).toMatchObject({ kind: 'refund' })
      expect((await holdLedger(over)).settles[0]).toMatchObject({ kind: 'spend' })

      // Through the real grouped read /credits makes (the user's own view rows).
      const groups = await readLedgerGroups(admin, user.id, 'this_month', { fresh: true })
      const result = aggregateCreditsPeriod(groups, [])
      const shots = result.byStep.flatMap((s) => s.operations).find((o) => o.operation === 'generate_shots')!
      expect(shots.credits).toBe(8 + 32)
      expect(shots.unitLabel).toBe('2 generations')
    } finally {
      await deleteTestUser(user.id)
    }
  })
})
