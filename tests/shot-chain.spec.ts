import { test, expect } from '@playwright/test'
import { admin, createFreshUser, releaseTestUser } from './supabase-test-session'
import { realRecordDynamicSpend } from './helpers/ledger-child'
import { scriptedGateway, successMessage, textMessage, throwingGateway } from './helpers/claude-fakes'
import {
  REAL_SHOT_LEDGER,
  chainGateway,
  ensureTestCredits,
  fakeOutline,
  holdLedger,
  fakeShot,
  insertChainProject,
  readChainShots,
  readRun,
  runChain,
  runChainFrom,
  type FakeShot,
} from './helpers/shot-chain'
import { shotGenerationCredits, usdToCredits } from '../src/lib/config/credits'
import { hasLiveShotRun, settleDeadShotRuns } from '../src/lib/shots/runs'
import { shotRunView, canGenerateRemaining } from '../src/app/(app)/projects/[id]/workbench/_components/shot-run-view'
import { derivePhase } from '../src/app/(app)/projects/[id]/workbench/_components/derive-phase'
import { runAgentTurn } from '../src/app/api/projects/[id]/agent/logic'
import { loadAgentMessages } from '../src/lib/load-agent-messages'
import { formatCredits } from '../src/lib/format-credits'
import { getAgentStepConfig } from '../src/app/api/projects/[id]/agent/steps'
import type { ShotsContinuationPayload } from '../src/app/api/projects/[id]/shots/worker'

// The shot-generation chain end to end against the database, every provider call a fake:
// the outline and the chunks, hand-offs between runs, the code-enforced limits, the hold
// and its one settle per action, a dead chain, the balance checks, and the agent path.

const REAL_LEDGER = REAL_SHOT_LEDGER

async function ledgerRows(projectId: string) {
  const { data, error } = await admin.from('credit_ledger').select('*').eq('project_id', projectId)
  expect(error).toBeNull()
  return data ?? []
}

async function usageRows(projectId: string) {
  const { data, error } = await admin.from('usage').select('*').eq('project_id', projectId)
  expect(error).toBeNull()
  return data ?? []
}

async function generationRow(projectId: string, operation: 'generate_shots' | 'agent_turn' = 'generate_shots') {
  const { data } = await admin
    .from('generations')
    .select('id, state, payload, started_at')
    .eq('project_id', projectId)
    .eq('operation', operation)
    .is('shot_id', null)
    .maybeSingle()
  return data
}

// Four spoken words each: 4 / 2.17 + 0.25 = 2.09s -> 3s on Wan 3.0.
const fourWords = (tag: string) => `${tag} spoken words here`


// Each test owns a pool user: a run places a hold on its user's next hold slot and spends
// against its balance, so neither the shared fixed user's balance nor its other runs may
// decide the outcome.
let owner: { id: string }
test.beforeEach(async () => {
  owner = await createFreshUser()
})
test.afterEach(async () => {
  await releaseTestUser(owner.id)
})

test.describe('shot chain - a long list across several runs', () => {
  test('150 shots across several hand-offs: contiguous positions in scene order, no run starts a chunk past its budget, a hold never exceeded, one usage row per call', async () => {
    test.setTimeout(300_000)
    // 8-10 min on Wan 3.0: 15 scenes of 36s (540s, the tier target), each planned as 10 shots -
    // slots of 3, 3, 3, 3, 4, 4, 4, 4, 4, 4. Each scene's first request asks for 8, its second
    // for the last 2 - 150 shots on their slots (540s).
    const projectId = await insertChainProject(owner.id, { duration_target: '8-10min' })
    const scenes = Array.from({ length: 15 }, (_, i) => ({ title: `Scene ${i + 1}`, seconds: 36, shot_count: 10 }))
    const gateway = chainGateway({
      outline: fakeOutline(scenes),
      delayMs: 100,
      chunk: (ask, n) => {
        const count = n === 0 ? 8 : 2
        return {
          shots: Array.from({ length: count }, (_, i) => fakeShot(fourWords(`s${ask.scenePosition}c${n}i${i}`))),
          scene_complete: n > 0,
        }
      },
    })
    const budget = 3_000
    const { request, runs } = await runChain({
      projectId,
      userId: owner.id,
      gateway,
      ledger: REAL_LEDGER,
      runBudgetMs: budget,
      concurrency: 3,
    })
    expect(request.ok).toBe(true)
    expect(runs.length).toBeGreaterThan(1) // it handed off at least once
    expect(runs.at(-1)!.result).toMatchObject({ outcome: 'finished', status: 'completed' })

    // No run started a chunk after its budget: every chunk's start sits inside the
    // budget of the run that started it.
    const run = await readRun((request as { runId: string }).runId)
    for (const chunk of run.shot_run_chunks as { started_at: string }[]) {
      const at = new Date(chunk.started_at).getTime()
      const owner = [...runs].reverse().find((r) => r.startedAt <= at)!
      expect(at - owner.startedAt).toBeLessThan(budget)
    }

    const shots = await readChainShots(projectId)
    expect(shots.length).toBe(150)
    expect(shots.map((s) => s.order_index)).toEqual(Array.from({ length: 150 }, (_, i) => i))
    // In scene order, and each scene's chunks in order.
    const expected = scenes.flatMap((_, sc) => [
      ...Array.from({ length: 8 }, (_, i) => `s${sc}c0i${i}`),
      ...Array.from({ length: 2 }, (_, i) => `s${sc}c1i${i}`),
    ])
    expect(shots.map((s) => s.voice_over.split(' ')[0])).toEqual(expected)
    expect(shots.map((s) => s.duration_sec)).toEqual(scenes.flatMap(() => [3, 3, 3, 3, 4, 4, 4, 4, 4, 4]))
    // Every scene asked for 8 slots, then its last 2.
    const asked = gateway.calls.filter((c) => c.tool === 'write_shots').map((c) => c.ask!.maxShots)
    expect(asked.sort((a, b) => a - b)).toEqual([...Array(15).fill(2), ...Array(15).fill(8)])

    // The hold (the tier's quote) ran short of 150 shots (300 credits): a button run is
    // charged at most its hold, so the hold stands alone - no excess spend.
    const ledger = await holdLedger(projectId)
    expect(ledger.rows).toHaveLength(1)
    expect(ledger.holds[0]).toMatchObject({ operation: 'generate_shots', pricing_mode: 'fixed', delta: -shotGenerationCredits('8-10min') })
    expect(ledger.net).toBe(shotGenerationCredits('8-10min'))
    // One usage row per provider call: the outline and 30 chunks.
    const usage = await usageRows(projectId)
    expect(usage.length).toBe(gateway.calls.length)
    expect(usage.length).toBe(31)
    expect(usage.every((u) => u.operation === 'generate_shots' && u.status === 'succeeded')).toBe(true)

    expect((await generationRow(projectId))!.state).toBe('succeeded')
    expect((await generationRow(projectId))!.payload).toBeNull()
  })

  test('each chunk continues from the shot saved before it', async () => {
    const projectId = await insertChainProject(owner.id, { duration_target: '30-60s' })
    const gateway = chainGateway({
      outline: fakeOutline([{ title: 'Only', seconds: 45 }]),
      chunk: (ask, n) => ({
        shots: Array.from({ length: n === 0 ? 3 : 2 }, (_, i) => fakeShot(fourWords(`c${n}i${i}`))),
        scene_complete: n > 0,
      }),
    })
    await runChain({ projectId, userId: owner.id, gateway })
    const chunkCalls = gateway.calls.filter((c) => c.tool === 'write_shots')
    expect(chunkCalls[0].ask!.previous).toBeNull()
    expect(chunkCalls[1].ask!.previous).toBe(fourWords('c0i2'))
  })
})

test.describe('shot chain - limits enforced in code', () => {
  test('every complete shot the model returns is saved - past the chunk cap and past the scene target', { tag: '@smoke' }, async () => {
    // 30-60s on Wan 3.0: two scenes of ~22s. The model returns 12 two-second shots (24s, past
    // its cap of 8 and its scene's target) and never says a scene is done.
    const projectId = await insertChainProject(owner.id, { duration_target: '30-60s', source_text: 'Make 80 shots.' })
    const gateway = chainGateway({
      outline: fakeOutline([{ title: 'A', seconds: 30 }, { title: 'B', seconds: 30 }]),
      chunk: () => ({ shots: Array.from({ length: 12 }, (_, i) => fakeShot(`w${i}`)), scene_complete: false }),
    })
    const { request } = await runChain({ projectId, userId: owner.id, gateway })
    const shots = await readChainShots(projectId)
    expect(shots.length).toBe(24)
    const run = await readRun((request as { runId: string }).runId)
    expect(run.status).toBe('completed')
    const asked = run.shot_run_chunks as { shots_saved: number; shots_returned: number; max_shots: number }[]
    for (const chunk of asked) {
      expect(chunk.shots_saved).toBe(chunk.shots_returned)
      expect(chunk.shots_saved).toBeGreaterThan(chunk.max_shots)
    }
    // Each scene reached its target in one answer, so neither was asked again.
    expect(gateway.calls.filter((c) => c.tool === 'write_shots')).toHaveLength(2)
  })

  test('an outline outside the tier range is rescaled into it before any shot is written', async () => {
    const projectId = await insertChainProject(owner.id, { duration_target: '30-60s' })
    const gateway = chainGateway({
      outline: fakeOutline([{ title: 'Long', seconds: 300 }, { title: 'Longer', seconds: 300 }]),
      chunk: () => ({ shots: [fakeShot(fourWords('x'))], scene_complete: true }),
    })
    await runChain({ projectId, userId: owner.id, gateway })
    const { data: scenes } = await admin.from('scenes').select('target_seconds').eq('project_id', projectId)
    const total = (scenes ?? []).reduce((sum, s) => sum + (s.target_seconds ?? 0), 0)
    expect(total).toBe(45)
  })

  test('"4 shots" yields 4', async () => {
    const projectId = await insertChainProject(owner.id, { duration_target: '30-60s', source_text: 'Exactly 4 shots.' })
    const gateway = chainGateway({
      outline: fakeOutline([{ title: 'Four', seconds: 45, shot_count: 4 }]),
      chunk: () => ({ shots: [1, 2, 3, 4].map((i) => fakeShot(fourWords(`f${i}`))), scene_complete: true }),
    })
    await runChain({ projectId, userId: owner.id, gateway, ledger: REAL_LEDGER })
    expect((await readChainShots(projectId)).length).toBe(4)
    expect((await holdLedger(projectId)).net).toBe(8)
  })

  test('durations are code-owned: each shot takes its slot - narrated, dialogue and silent alike - and only a shot still over its cap is lengthened, clamped and overflow-flagged', async () => {
    // Kling v3: 3-15s. The outline rescales to 31s and 59s; scene One is planned as 4 slots -
    // 7, 8, 8, 8 - and scene Two as 14, 15, 15, 15.
    const projectId = await insertChainProject(owner.id, { duration_target: '1-2min', video_model: 'kling-v3-standard' })
    const many = Array.from({ length: 80 }, (_, i) => `w${i}`).join(' ')
    const shots: FakeShot[] = [
      fakeShot(Array.from({ length: 13 }, (_, i) => `n${i}`).join(' '), { duration_sec: 2 }), // 13 words: inside 7s's 14
      fakeShot('Two words', { dialogue: [{ speaker_name: 'Mara', line: 'one two three four five six seven eight' }] }), // 10 with the dialogue
      fakeShot('', { duration_sec: 3 }), // silent: its slot's 8s, never Claude's estimate
      fakeShot(many), // 80 words, still 80 after its rewrite: 37s -> clamped to 15, flagged
    ]
    const gateway = chainGateway({
      outline: fakeOutline([
        { title: 'One', seconds: 30, shot_count: 4 },
        { title: 'Two', seconds: 60, shot_count: 4 },
      ]),
      chunk: (ask) => ({ shots: ask.scenePosition === 0 ? shots : [1, 2, 3, 4].map((i) => fakeShot(fourWords(`t${i}`))), scene_complete: true }),
      rewrite: (ask) => ({ voice_over: ask.voiceOver, dialogue: [] }),
    })
    await runChain({ projectId, userId: owner.id, gateway })
    const saved = await readChainShots(projectId)
    expect(saved.map((s) => s.duration_sec)).toEqual([7, 8, 8, 15, 14, 15, 15, 15])
    expect(saved.map((s) => s.narration_overflow)).toEqual([false, false, false, true, false, false, false, false])
    expect(gateway.calls.filter((c) => c.tool === 'rewrite_shot')).toHaveLength(1)
  })
})

test.describe('shot chain - recovery and failure', () => {
  test('a stored outline is replayed without a new outline call', async () => {
    const projectId = await insertChainProject(owner.id, { duration_target: '30-60s' })
    await admin.from('generations').insert({
      project_id: projectId,
      step: 'workbench',
      operation: 'generate_shots',
      shot_id: null,
      element_id: null,
      state: 'failed',
      payload: fakeOutline([{ title: 'Replayed', seconds: 45 }]) as never,
    })
    const gateway = chainGateway({
      outline: fakeOutline([{ title: 'Never asked', seconds: 45 }]),
      chunk: () => ({ shots: [fakeShot(fourWords('r'))], scene_complete: true }),
    })
    await runChain({ projectId, userId: owner.id, gateway, retry: true })
    expect(gateway.calls.filter((c) => c.tool === 'write_outline')).toHaveLength(0)
    expect((await readChainShots(projectId))[0].scenes!.title).toBe('Replayed')
  })

  test('a claim already running is refused 409 and nothing is called', async () => {
    const projectId = await insertChainProject(owner.id)
    const gateway = chainGateway({ outline: fakeOutline([{ title: 'A', seconds: 90 }]), chunk: () => ({ shots: [fakeShot('x')], scene_complete: true }) })
    const first = await runChain({ projectId, userId: owner.id, gateway, handOff: () => 'drop', runBudgetMs: 0 })
    expect(first.request.ok).toBe(true)
    const second = await runChain({ projectId, userId: owner.id, gateway: throwingGateway('never'), retry: true })
    expect(second.request).toMatchObject({ ok: false, status: 409 })
  })

  test('a dead chain releases its hold: settled once at what was saved, and settling again never charges twice', async () => {
    test.setTimeout(60_000)
    const projectId = await insertChainProject(owner.id, { duration_target: '30-60s' })
    // The first run writes scene A then hands off; the continuation is "accepted" but
    // never runs - the invocation died.
    // Each chunk takes 4.5s against a 4s budget, so the first run writes scene A and hands
    // the rest on.
    const slow = chainGateway({
      outline: fakeOutline([{ title: 'A', seconds: 20 }, { title: 'B', seconds: 25 }]),
      delayMs: 4_500,
      chunk: () => ({ shots: [1, 2, 3].map((i) => fakeShot(fourWords(`d${i}`))), scene_complete: true }),
    })
    const { request } = await runChain({
      projectId,
      userId: owner.id,
      gateway: slow,
      ledger: REAL_LEDGER,
      concurrency: 1,
      runBudgetMs: 4_000,
      handOff: () => 'drop',
    })
    const runId = (request as { runId: string }).runId
    expect((await readRun(runId)).status).toBe('running')
    // Only the hold so far.
    expect((await holdLedger(projectId)).rows).toHaveLength(1)

    // Inside the stale window nothing is settled; past it, the first touch settles it.
    expect((await settleDeadShotRuns(admin, REAL_LEDGER, projectId)).changed).toBe(false)
    const old = new Date(Date.now() - 10 * 60_000).toISOString()
    await admin.from('shot_runs').update({ heartbeat_at: old }).eq('id', runId)
    expect((await settleDeadShotRuns(admin, REAL_LEDGER, projectId)).changed).toBe(true)
    await settleDeadShotRuns(admin, REAL_LEDGER, projectId)

    const run = await readRun(runId)
    expect(run).toMatchObject({ status: 'failed', stop_reason: 'stale' })
    const saved = await readChainShots(projectId)
    expect(saved.length).toBeGreaterThan(0)
    const ledger = await holdLedger(projectId)
    expect(ledger.holds).toHaveLength(1)
    expect(ledger.settles).toHaveLength(1)
    expect(ledger.settles[0]).toMatchObject({ kind: 'refund', refunds_ledger_id: (ledger.rows.find((r) => r.dedupe_key.startsWith('hold:')) as { id: string }).id })
    expect(ledger.net).toBe(2 * saved.length)
    // The page then shows a failed state with retry - never a spinner.
    const generation = await generationRow(projectId)
    expect(derivePhase({ generation: { state: generation!.state }, shotCount: saved.length })).toBe('partial')
  })
})

test.describe('shot chain - balance', () => {
  test('the pre-flight 402 (the hold quote) writes nothing and calls nothing', async () => {
    const projectId = await insertChainProject(owner.id, { duration_target: '1-2min' }) // 120s / 8.45 -> 15 shots -> 30 credits
    const { request } = await runChain({ projectId, userId: owner.id, gateway: throwingGateway('never'), balance: 29 })
    expect(request).toMatchObject({ ok: false, status: 402, requiredCredits: 30, balanceCredits: 29 })
    expect(await generationRow(projectId)).toBeNull()
    const { data: runs } = await admin.from('shot_runs').select('id').eq('project_id', projectId)
    expect(runs).toHaveLength(0)
    expect(await usageRows(projectId)).toHaveLength(0)
    expect(await ledgerRows(projectId)).toHaveLength(0)
  })

  test('past its hold an agent run reads the balance: out of credits it stops, keeping what was saved, and "Generate remaining shots" is its own held action, charged at most its hold', async () => {
    const projectId = await insertChainProject(owner.id, { duration_target: '30-60s' }) // hold 16
    const outline = fakeOutline([
      { title: 'A', seconds: 15, shot_count: 4 },
      { title: 'B', seconds: 15, shot_count: 4 },
      { title: 'C', seconds: 15, shot_count: 4 },
    ])
    const chunk = (ask: { scenePosition: number }) => ({
      shots: [1, 2, 3, 4].map((i) => fakeShot(fourWords(`b${ask.scenePosition}i${i}`))),
      scene_complete: true,
    })
    // An agent run pays its measured cost: each call here is 10,000 output tokens on Haiku 5.5
    // ($0.005, 5 credits). Chunk 1 projects 5 (the outline) + 8 (its 4 shots in flight) = 13,
    // inside the hold - no read. Chunk 2 projects 10 + 8 = 18 > 16: the balance (1, past the
    // hold) can't cover the 2 excess, so the run stops with scene A's 4 shots saved.
    const { data: agentClaim } = await admin
      .from('generations')
      .insert({ project_id: projectId, step: 'workbench', operation: 'agent_turn', shot_id: null, element_id: null, state: 'generating' })
      .select('id')
      .single()
    let reads = 0
    const first = await runChain({
      projectId,
      userId: owner.id,
      gateway: chainGateway({ outline, chunk, usage: { input_tokens: 0, output_tokens: 10_000 } }),
      ledger: REAL_LEDGER,
      agentGenerationId: agentClaim!.id,
      balance: () => {
        reads += 1
        return reads === 1 ? 1_000 : 1 // the pre-flight, then the in-run read
      },
      concurrency: 1,
    })
    const firstRun = await readRun((first.request as { runId: string }).runId)
    expect(firstRun).toMatchObject({ status: 'stopped', stop_reason: 'balance' })
    expect(reads).toBe(2) // no read before the hold was reached
    const afterFirst = await readChainShots(projectId)
    expect(afterFirst.length).toBe(4)
    const { data: scenes } = await admin.from('scenes').select('id, shot_run_chunks(scene_complete)').eq('project_id', projectId)
    const view = shotRunView(firstRun, (scenes ?? []) as { shot_run_chunks: { scene_complete: boolean }[] }[])
    expect(canGenerateRemaining(view)).toBe(true)

    // "Generate remaining shots" (the button) holds the two unwritten scenes' quote - 40s of
    // them, 5 shots, 10 credits - writes their 8 shots, and is charged its hold, never more.
    const remaining = await runChain({
      projectId,
      userId: owner.id,
      gateway: chainGateway({ outline, chunk }),
      mode: 'remaining',
      ledger: REAL_LEDGER,
    })
    expect(remaining.request.ok).toBe(true)
    const shots = await readChainShots(projectId)
    expect(shots.length).toBe(12)
    expect(shots.map((s) => s.order_index)).toEqual(Array.from({ length: 12 }, (_, i) => i))
    expect(shots.map((s) => s.scenes!.title)).toEqual([...Array(4).fill('A'), ...Array(4).fill('B'), ...Array(4).fill('C')])
    const ledger = await holdLedger(projectId)
    expect(ledger.holds.map((h) => h.operation).sort()).toEqual(['agent_turn', 'generate_shots'])
    const button = ledger.rows.filter((r) => r.operation === 'generate_shots')
    expect(button.map((r) => r.delta)).toEqual([-10])
  })
})

test.describe('shot chain - the agent path', () => {
  test('regenerate_all_shots starts the chain: the lock is held until it ends, and its dynamic agent_turn hold settles at the sum of every usage row of the turn - no fixed-price row', async () => {
    test.setTimeout(120_000)
    const projectId = await insertChainProject(owner.id, { duration_target: '30-60s' })
    await ensureTestCredits(owner.id)
    const usage = { input_tokens: 400, output_tokens: 300 }
    const turnGateway = scriptedGateway([
      successMessage({}, 'regenerate_all_shots', { ...usage, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }),
      textMessage('Rewriting the shot list now.', { ...usage, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }),
    ])
    const scheduled: (Omit<ShotsContinuationPayload, 'chainDepth'> & { chainDepth: 0 })[] = []

    const turn = await runAgentTurn({
      config: getAgentStepConfig('workbench'),
      gateway: turnGateway,
      supabase: admin,
      projectId,
      userId: owner.id,
      content: 'start over with new shots',
      clientId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      recordTurnSpend: realRecordDynamicSpend,
      getBalance: async () => 1_000_000,
      ensureSignupGrant: async () => {},
      shotRuns: { ledger: REAL_LEDGER, start: async (run) => {
        scheduled.push(run)
        return true
      } },
    })
    expect(turn.ok).toBe(true)
    expect(scheduled).toHaveLength(1)

    // The chain is running: the agent is locked and only its hold exists.
    expect(await hasLiveShotRun(admin, projectId)).toBe(true)
    expect((await generationRow(projectId, 'agent_turn'))!.state).toBe('generating')
    const held = await holdLedger(projectId)
    expect(held.rows).toHaveLength(1)
    expect(held.holds[0]).toMatchObject({ operation: 'agent_turn', pricing_mode: 'dynamic', delta: -shotGenerationCredits('30-60s') })
    const blocked = await runAgentTurn({
      config: getAgentStepConfig('workbench'),
      gateway: throwingGateway('a locked turn never calls Claude'),
      supabase: admin,
      projectId,
      userId: owner.id,
      content: 'and another thing',
      clientId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      recordTurnSpend: realRecordDynamicSpend,
      shotRuns: { ledger: REAL_LEDGER, start: async () => true },
    })
    expect(blocked).toMatchObject({ ok: false, status: 409 })

    const chainGw = chainGateway({
      outline: fakeOutline([{ title: 'A', seconds: 20 }, { title: 'B', seconds: 25 }]),
      usage,
      chunk: () => ({ shots: [1, 2].map((i) => fakeShot(fourWords(`g${i}`))), scene_complete: true }),
    })
    await runChainFrom({ projectId, userId: owner.id, gateway: chainGw, ledger: REAL_LEDGER }, scheduled[0])

    const { data: message } = await admin
      .from('messages')
      .select('id')
      .eq('project_id', projectId)
      .eq('role', 'user')
      .eq('content', 'start over with new shots')
      .single()
    const turnUsage = (await usageRows(projectId)).filter((u) => u.message_id === message!.id)
    expect(turnUsage.length).toBe(2 + chainGw.calls.length) // the turn's two calls and every chain call
    const ledger = await holdLedger(projectId)
    expect(ledger.holds).toHaveLength(1)
    expect(ledger.settles.length).toBeLessThanOrEqual(1)
    expect(ledger.rows.every((r) => r.operation === 'agent_turn' && r.message_id === message!.id)).toBe(true)
    expect(ledger.net).toBe(usdToCredits(turnUsage.reduce((sum, u) => sum + Number(u.estimated_cost), 0)))
    // The agent panel's cost line shows the turn's net charge - hold less refund, never the hold.
    const panel = await loadAgentMessages(admin as never, projectId, [])
    expect(panel.find((m) => m.kind === 'cost')).toMatchObject({ creditAmount: `${formatCredits(ledger.net)} cr` })
    // The lock is released by the chain's end.
    expect((await generationRow(projectId, 'agent_turn'))!.state).toBe('succeeded')
    expect(await hasLiveShotRun(admin, projectId)).toBe(false)
  })
})
