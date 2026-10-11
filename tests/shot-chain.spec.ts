import { test, expect } from '@playwright/test'
import { admin } from './supabase-test-session'
import { primary } from './fixed-users'
import { realRecordDynamicSpend, realRecordFixedSpend } from './helpers/ledger-child'
import { scriptedGateway, successMessage, textMessage, throwingGateway } from './helpers/claude-fakes'
import {
  chainGateway,
  fakeOutline,
  fakeShot,
  insertChainProject,
  readChainShots,
  readRun,
  runChain,
  runChainFrom,
  type FakeShot,
} from './helpers/shot-chain'
import { usdToCredits } from '../src/lib/config/credits'
import { hasLiveShotRun, settleDeadShotRuns, type ShotRunLedger } from '../src/lib/shots/runs'
import { shotRunView, canGenerateRemaining } from '../src/app/(app)/projects/[id]/workbench/_components/shot-run-view'
import { derivePhase } from '../src/app/(app)/projects/[id]/workbench/_components/derive-phase'
import { runAgentTurn } from '../src/app/api/projects/[id]/agent/logic'
import { getAgentStepConfig } from '../src/app/api/projects/[id]/agent/steps'
import type { ShotsContinuationPayload } from '../src/app/api/projects/[id]/shots/worker'

// The shot-generation chain end to end against the database, every provider call a fake:
// the outline and the chunks, hand-offs between runs, the code-enforced limits, the one
// ledger row per action, a dead chain, the balance checks, and the agent path.

const REAL_LEDGER: ShotRunLedger = { recordFixedSpend: realRecordFixedSpend, recordDynamicSpend: realRecordDynamicSpend }

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

test.describe('shot chain - a long list across several runs', () => {
  test('150 shots across several hand-offs: contiguous positions in scene order, no run starts a chunk past its budget, one ledger row, one usage row per call', async () => {
    test.setTimeout(300_000)
    // 8-10 min on Wan 3.0: 15 scenes of 36s (540s, the tier target); each writes 8 shots,
    // then 2 more, then reports the scene complete - 150 shots of 3s (450s).
    const projectId = await insertChainProject(primary.user.id, { duration_target: '8-10min' })
    const scenes = Array.from({ length: 15 }, (_, i) => ({ title: `Scene ${i + 1}`, seconds: 36 }))
    const gateway = chainGateway({
      outline: fakeOutline(scenes),
      delayMs: 25,
      chunk: (ask, n) => {
        const count = n === 0 ? 8 : 2
        return {
          shots: Array.from({ length: count }, (_, i) => fakeShot(fourWords(`s${ask.scenePosition}c${n}i${i}`))),
          scene_complete: n > 0,
        }
      },
    })
    const budget = 1_500
    const { request, runs } = await runChain({
      projectId,
      userId: primary.user.id,
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
    expect(shots.every((s) => s.duration_sec === 3)).toBe(true)

    const ledger = await ledgerRows(projectId)
    expect(ledger.length).toBe(1)
    expect(ledger[0]).toMatchObject({ operation: 'generate_shots', pricing_mode: 'fixed', delta: -300 })
    // One usage row per provider call: the outline and 30 chunks.
    const usage = await usageRows(projectId)
    expect(usage.length).toBe(gateway.calls.length)
    expect(usage.length).toBe(31)
    expect(usage.every((u) => u.operation === 'generate_shots' && u.status === 'succeeded')).toBe(true)

    expect((await generationRow(projectId))!.state).toBe('succeeded')
    expect((await generationRow(projectId))!.payload).toBeNull()
  })

  test('each chunk continues from the shot saved before it', async () => {
    const projectId = await insertChainProject(primary.user.id, { duration_target: '30-60s' })
    const gateway = chainGateway({
      outline: fakeOutline([{ title: 'Only', seconds: 45 }]),
      chunk: (ask, n) => ({
        shots: Array.from({ length: n === 0 ? 3 : 2 }, (_, i) => fakeShot(fourWords(`c${n}i${i}`))),
        scene_complete: n > 0,
      }),
    })
    await runChain({ projectId, userId: primary.user.id, gateway })
    const chunkCalls = gateway.calls.filter((c) => c.tool === 'write_shots')
    expect(chunkCalls[0].ask!.previous).toBeNull()
    expect(chunkCalls[1].ask!.previous).toBe(fourWords('c0i2'))
  })
})

test.describe('shot chain - limits enforced in code', () => {
  test('a description asking for more shots than the ceiling never yields more than the ceiling, and extras a chunk returns past its cap are not saved', async () => {
    // 30-60s on Wan 3.0: ceiling 60 / 2 = 30 shots. The model keeps returning 12 shots
    // (over the chunk's cap) and never says a scene is done.
    const projectId = await insertChainProject(primary.user.id, { duration_target: '30-60s', source_text: 'Make 80 shots.' })
    const gateway = chainGateway({
      outline: fakeOutline([{ title: 'A', seconds: 30 }, { title: 'B', seconds: 30 }]),
      // One word each: 2s, the model minimum - so the ceiling is reachable.
      chunk: () => ({ shots: Array.from({ length: 12 }, (_, i) => fakeShot(`w${i}`)), scene_complete: false }),
    })
    const { request } = await runChain({ projectId, userId: primary.user.id, gateway })
    const shots = await readChainShots(projectId)
    expect(shots.length).toBe(30)
    expect(shots.reduce((sum, s) => sum + (s.duration_sec ?? 0), 0)).toBeLessThanOrEqual(60)
    const run = await readRun((request as { runId: string }).runId)
    for (const chunk of run.shot_run_chunks as { shots_saved: number; max_shots: number }[]) {
      expect(chunk.shots_saved).toBeLessThanOrEqual(chunk.max_shots)
      expect(chunk.max_shots).toBeLessThanOrEqual(8)
    }
  })

  test('an outline outside the tier range is rescaled into it before any shot is written', async () => {
    const projectId = await insertChainProject(primary.user.id, { duration_target: '30-60s' })
    const gateway = chainGateway({
      outline: fakeOutline([{ title: 'Long', seconds: 300 }, { title: 'Longer', seconds: 300 }]),
      chunk: () => ({ shots: [fakeShot(fourWords('x'))], scene_complete: true }),
    })
    await runChain({ projectId, userId: primary.user.id, gateway })
    const { data: scenes } = await admin.from('scenes').select('target_seconds').eq('project_id', projectId)
    const total = (scenes ?? []).reduce((sum, s) => sum + (s.target_seconds ?? 0), 0)
    expect(total).toBe(45)
  })

  test('"4 shots" yields 4', async () => {
    const projectId = await insertChainProject(primary.user.id, { duration_target: '30-60s', source_text: 'Exactly 4 shots.' })
    const gateway = chainGateway({
      outline: fakeOutline([{ title: 'Four', seconds: 45 }]),
      chunk: () => ({ shots: [1, 2, 3, 4].map((i) => fakeShot(fourWords(`f${i}`))), scene_complete: true }),
    })
    await runChain({ projectId, userId: primary.user.id, gateway, ledger: REAL_LEDGER })
    expect((await readChainShots(projectId)).length).toBe(4)
    expect((await ledgerRows(projectId))[0].delta).toBe(-8)
  })

  test('durations are computed by code: narrated, dialogue and silent shots, clamped and overflow-flagged, in whole seconds', async () => {
    // Kling v3: 3-15s.
    const projectId = await insertChainProject(primary.user.id, { duration_target: '1-2min', video_model: 'kling-v3-standard' })
    const many = Array.from({ length: 80 }, (_, i) => `w${i}`).join(' ')
    const shots: FakeShot[] = [
      fakeShot(Array.from({ length: 13 }, (_, i) => `n${i}`).join(' '), { duration_sec: 2 }), // 6.24 -> 7
      fakeShot('Two words', { dialogue: [{ speaker_name: 'Mara', line: 'one two three four five six seven eight' }] }), // 4.86 -> 5
      fakeShot('', { duration_sec: 6 }), // silent: Claude's estimate
      fakeShot(many), // 37s -> clamped to 15, flagged
    ]
    const gateway = chainGateway({ outline: fakeOutline([{ title: 'One', seconds: 90 }]), chunk: () => ({ shots, scene_complete: true }) })
    await runChain({ projectId, userId: primary.user.id, gateway })
    const saved = await readChainShots(projectId)
    expect(saved.map((s) => s.duration_sec)).toEqual([7, 5, 6, 15])
    expect(saved.map((s) => s.narration_overflow)).toEqual([false, false, false, true])
  })
})

test.describe('shot chain - recovery and failure', () => {
  test('a stored outline is replayed without a new outline call', async () => {
    const projectId = await insertChainProject(primary.user.id, { duration_target: '30-60s' })
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
    await runChain({ projectId, userId: primary.user.id, gateway, retry: true })
    expect(gateway.calls.filter((c) => c.tool === 'write_outline')).toHaveLength(0)
    expect((await readChainShots(projectId))[0].scenes!.title).toBe('Replayed')
  })

  test('a claim already running is refused 409 and nothing is called', async () => {
    const projectId = await insertChainProject(primary.user.id)
    const gateway = chainGateway({ outline: fakeOutline([{ title: 'A', seconds: 90 }]), chunk: () => ({ shots: [fakeShot('x')], scene_complete: true }) })
    const first = await runChain({ projectId, userId: primary.user.id, gateway, handOff: () => 'drop', runBudgetMs: 0 })
    expect(first.request.ok).toBe(true)
    const second = await runChain({ projectId, userId: primary.user.id, gateway: throwingGateway('never'), retry: true })
    expect(second.request).toMatchObject({ ok: false, status: 409 })
  })

  test('a dead chain is settled with one ledger row for what was saved, and settling again never charges twice', async () => {
    test.setTimeout(60_000)
    const projectId = await insertChainProject(primary.user.id, { duration_target: '30-60s' })
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
      userId: primary.user.id,
      gateway: slow,
      ledger: REAL_LEDGER,
      concurrency: 1,
      runBudgetMs: 4_000,
      handOff: () => 'drop',
    })
    const runId = (request as { runId: string }).runId
    expect((await readRun(runId)).status).toBe('running')
    expect(await ledgerRows(projectId)).toHaveLength(0)

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
    const ledger = await ledgerRows(projectId)
    expect(ledger).toHaveLength(1)
    expect(ledger[0].delta).toBe(-2 * saved.length)
    // The page then shows a failed state with retry - never a spinner.
    const generation = await generationRow(projectId)
    expect(derivePhase({ generation: { state: generation!.state }, shotCount: saved.length })).toBe('partial')
  })
})

test.describe('shot chain - balance', () => {
  test('the pre-flight 402 (2 credits x target shots) writes nothing and calls nothing', async () => {
    const projectId = await insertChainProject(primary.user.id, { duration_target: '1-2min' }) // target 15 -> 30 credits
    const { request } = await runChain({ projectId, userId: primary.user.id, gateway: throwingGateway('never'), balance: 29 })
    expect(request).toMatchObject({ ok: false, status: 402, requiredCredits: 30, balanceCredits: 29 })
    expect(await generationRow(projectId)).toBeNull()
    const { data: runs } = await admin.from('shot_runs').select('id').eq('project_id', projectId)
    expect(runs).toHaveLength(0)
    expect(await usageRows(projectId)).toHaveLength(0)
    expect(await ledgerRows(projectId)).toHaveLength(0)
  })

  test('the per-chunk re-check counts saved-but-uncharged shots, stops the chain, and "Generate remaining shots" is its own action with its own row', async () => {
    const projectId = await insertChainProject(primary.user.id, { duration_target: '30-60s' }) // pre-flight 16
    const outline = fakeOutline([{ title: 'A', seconds: 15 }, { title: 'B', seconds: 15 }, { title: 'C', seconds: 15 }])
    const chunk = (ask: { scenePosition: number }) => ({
      shots: [1, 2, 3, 4].map((i) => fakeShot(fourWords(`b${ask.scenePosition}i${i}`))),
      scene_complete: true,
    })
    // 24 credits, scenes of 15s (a chunk cap of 7 -> 14 credits held): the first chunk runs
    // and saves 4 uncharged shots; the next sees 24 - 8 = 16 >= 14 and runs; the third sees
    // 24 - 16 = 8 < 14 and stops the chain.
    const first = await runChain({ projectId, userId: primary.user.id, gateway: chainGateway({ outline, chunk }), ledger: REAL_LEDGER, balance: 24, concurrency: 1 })
    const firstRun = await readRun((first.request as { runId: string }).runId)
    expect(firstRun).toMatchObject({ status: 'stopped', stop_reason: 'balance' })
    const afterFirst = await readChainShots(projectId)
    expect(afterFirst.length).toBe(8)
    const { data: scenes } = await admin.from('scenes').select('id, shot_run_chunks(scene_complete)').eq('project_id', projectId)
    const view = shotRunView(firstRun, (scenes ?? []) as { shot_run_chunks: { scene_complete: boolean }[] }[])
    expect(canGenerateRemaining(view)).toBe(true)
    expect(await ledgerRows(projectId)).toHaveLength(1)

    const remaining = await runChain({
      projectId,
      userId: primary.user.id,
      gateway: chainGateway({ outline, chunk }),
      mode: 'remaining',
      ledger: REAL_LEDGER,
    })
    expect(remaining.request.ok).toBe(true)
    const shots = await readChainShots(projectId)
    expect(shots.length).toBe(12)
    expect(shots.map((s) => s.order_index)).toEqual(Array.from({ length: 12 }, (_, i) => i))
    expect(shots.map((s) => s.scenes!.title)).toEqual([...Array(4).fill('A'), ...Array(4).fill('B'), ...Array(4).fill('C')])
    const ledger = (await ledgerRows(projectId)).map((r) => r.delta).sort()
    expect(ledger).toEqual([-16, -8])
  })
})

test.describe('shot chain - the agent path', () => {
  test('regenerate_all_shots starts the chain: the lock is held until it ends, and one dynamic agent_turn row sums every usage row of the turn - no fixed-price row', async () => {
    test.setTimeout(120_000)
    const projectId = await insertChainProject(primary.user.id, { duration_target: '30-60s' })
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
      userId: primary.user.id,
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

    // The chain is running: the agent is locked and no ledger row exists yet.
    expect(await hasLiveShotRun(admin, projectId)).toBe(true)
    expect((await generationRow(projectId, 'agent_turn'))!.state).toBe('generating')
    expect(await ledgerRows(projectId)).toHaveLength(0)
    const blocked = await runAgentTurn({
      config: getAgentStepConfig('workbench'),
      gateway: throwingGateway('a locked turn never calls Claude'),
      supabase: admin,
      projectId,
      userId: primary.user.id,
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
    await runChainFrom({ projectId, userId: primary.user.id, gateway: chainGw, ledger: REAL_LEDGER }, scheduled[0])

    const { data: message } = await admin
      .from('messages')
      .select('id')
      .eq('project_id', projectId)
      .eq('role', 'user')
      .eq('content', 'start over with new shots')
      .single()
    const turnUsage = (await usageRows(projectId)).filter((u) => u.message_id === message!.id)
    expect(turnUsage.length).toBe(2 + chainGw.calls.length) // the turn's two calls and every chain call
    const ledger = await ledgerRows(projectId)
    expect(ledger).toHaveLength(1)
    expect(ledger[0]).toMatchObject({ operation: 'agent_turn', pricing_mode: 'dynamic', message_id: message!.id })
    expect(ledger[0].delta).toBe(-usdToCredits(turnUsage.reduce((sum, u) => sum + Number(u.estimated_cost), 0)))
    expect(ledger.some((r) => r.operation === 'generate_shots')).toBe(false)
    // The lock is released by the chain's end.
    expect((await generationRow(projectId, 'agent_turn'))!.state).toBe('succeeded')
    expect(await hasLiveShotRun(admin, projectId)).toBe(false)
  })
})
