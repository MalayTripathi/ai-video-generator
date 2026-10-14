import { test, expect } from '@playwright/test'
import { admin, createFreshUser, releaseTestUser } from './supabase-test-session'
import { realRecordDynamicSpend } from './helpers/ledger-child'
import { scriptedGateway, successMessage, textMessage } from './helpers/claude-fakes'
import {
  REAL_SHOT_LEDGER,
  chainGateway,
  ensureTestCredits,
  fakeOutline,
  holdLedger,
  fakeShot,
  faultyClient,
  insertChainProject,
  readChainShots,
  readRun,
  runChain,
  runChainFrom,
} from './helpers/shot-chain'
import { hasLiveShotRun, settleDeadShotRuns } from '../src/lib/shots/runs'
import { runAgentTurn } from '../src/app/api/projects/[id]/agent/logic'
import { loadShotsStatus } from '../src/app/api/projects/[id]/shots/status/logic'
import { deleteShotForUser } from '../src/app/(app)/projects/[id]/workbench/actions'
import { applyProjectSettings } from '../src/lib/projects/settings'
import { generateUniqueShotKeys } from '../src/lib/shot-key'
import { getAgentStepConfig } from '../src/app/api/projects/[id]/agent/steps'
import {
  SHOTS_INTERNAL_SECRET_HEADER,
  createShotsContinueRun,
  parseShotsContinuationPayload,
  type ShotsContinuationPayload,
} from '../src/app/api/projects/[id]/shots/worker'
import { shotRunView, canGenerateRemaining } from '../src/app/(app)/projects/[id]/workbench/_components/shot-run-view'
import { derivePhase } from '../src/app/(app)/projects/[id]/workbench/_components/derive-phase'
import { SCENE_BATCH_FACTOR, SCENE_EMPTY_ANSWER_LIMIT, SCENE_EXTRA_REQUESTS } from '../src/lib/config/shots'
import { shotCountFor } from '../src/lib/config/credits'
import { chunkSizes } from '../src/lib/shots/limits'

// Layer: api. The shot chain's guarantees, against the database with fake gateways: every
// complete shot returned is kept, a scene's slots keep a long scene from starving the next,
// a run is 'completed' only when every scene is, the progress guard ends a chain that saves
// nothing, a truncated chunk keeps its whole shots, and a run's end is safe to kill and its
// hold is never settled by a request landing while it is still writing.

const REAL_LEDGER = REAL_SHOT_LEDGER

/** The project's hold settled exactly once, netting to `net` credits for `operation`. */
async function expectSettledOnce(projectId: string, net: number, operation: 'generate_shots' | 'agent_turn' = 'generate_shots') {
  const ledger = await holdLedger(projectId)
  expect(ledger.holds).toHaveLength(1)
  expect(ledger.rows.length).toBeLessThanOrEqual(2)
  expect(ledger.rows.every((r) => r.operation === operation)).toBe(true)
  expect(ledger.net).toBe(net)
}

/** Nothing settled yet: only the hold. */
async function expectOnlyHold(projectId: string) {
  const ledger = await holdLedger(projectId)
  expect(ledger.holds).toHaveLength(1)
  expect(ledger.settles).toHaveLength(0)
}

/** Spoken text of `n` words. On Wan 3.0: 1 word -> 2s, 10 -> 5s, 21 -> 10s, 32 -> 15s. */
const words = (tag: string, n: number) => [tag, ...Array.from({ length: n - 1 }, (_, i) => `w${i}`)].join(' ')

async function claimState(projectId: string) {
  const { data } = await admin
    .from('generations')
    .select('state')
    .eq('project_id', projectId)
    .eq('operation', 'generate_shots')
    .is('shot_id', null)
    .maybeSingle()
  return data?.state ?? null
}

async function viewOf(projectId: string, runId: string) {
  const run = await readRun(runId)
  const { data: scenes } = await admin.from('scenes').select('id, shot_run_chunks(scene_complete)').eq('project_id', projectId)
  return shotRunView(run, (scenes ?? []) as { shot_run_chunks: { scene_complete: boolean }[] }[])
}

const ageRun = (runId: string) => {
  const old = new Date(Date.now() - 10 * 60_000).toISOString()
  return admin.from('shot_runs').update({ heartbeat_at: old, finished_at: old }).eq('id', runId)
}


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

test.describe('shot chain - a long scene across many runs', () => {
  for (const sceneCount of [1, 2]) {
    test(`a ${sceneCount}-scene 8-10 min project writes each scene to its target across many runs, keeping every shot`, async () => {
      test.setTimeout(600_000)
      // 8-10 min on Wan 3.0: the outline is rescaled to the tier's 540s target, planned as 100
      // slots in all (5s and 6s each). Every answer returns 16 one-word shots - more than the 8
      // asked, all kept, each taking the scene's next slot - never saying a scene is done. Each
      // scene ends on the answer that fills its last slot; the extras past it keep their own 2s:
      // one scene of 100 slots takes 7 answers (112 shots, 540s + 12 x 2s); two of 50 take 4
      // each (128 shots, 540s + 28 x 2s).
      const projectId = await insertChainProject(owner.id, { duration_target: '8-10min' })
      const outline = fakeOutline(
        Array.from({ length: sceneCount }, (_, i) => ({ title: `S${i}`, seconds: 600 / sceneCount, shot_count: 100 / sceneCount }))
      )
      const gateway = chainGateway({
        outline,
        // Slow enough that a scene's answers outlast one run's budget: the chain hands off.
        delayMs: 800,
        chunk: (ask, n) => ({
          shots: Array.from({ length: 16 }, (_, i) => fakeShot(`s${ask.scenePosition}c${n}i${i}`)),
          scene_complete: false,
        }),
      })
      const { request, runs } = await runChain({
        projectId,
        userId: owner.id,
        gateway,
        ledger: REAL_LEDGER,
        runBudgetMs: 3_000,
      })
      expect(request.ok).toBe(true)
      expect(runs.length).toBeGreaterThan(1)
      expect(runs.at(-1)!.result).toMatchObject({ outcome: 'finished', status: 'completed' })

      const expected = sceneCount === 1 ? { shots: 112, seconds: 564 } : { shots: 128, seconds: 596 }
      const shots = await readChainShots(projectId)
      expect(shots.length).toBe(expected.shots)
      expect(shots.map((s) => s.order_index)).toEqual(Array.from({ length: expected.shots }, (_, i) => i))
      expect(shots.reduce((sum, s) => sum + (s.duration_sec ?? 0), 0)).toBe(expected.seconds)
      // Past the hold (144): a button run is charged at most its hold.
      await expectSettledOnce(projectId, 144)
      expect(await claimState(projectId)).toBe('succeeded')
    })
  }
})

test.describe('shot chain - scene targets and shares', () => {
  test('a scene overrunning its target in parallel keeps every shot and never starves the next scene; the project ends over range', async () => {
    // 30-60s on Wan 3.0: two scenes rescaled to 23s and 22s, 3 slots each. Each chunk returns 8
    // ten-word shots - 3 on the scene's slots and 5 extras of 5s past them. Scene B finishes first.
    const projectId = await insertChainProject(owner.id, { duration_target: '30-60s' })
    const gateway = chainGateway({
      outline: fakeOutline([{ title: 'A', seconds: 30 }, { title: 'B', seconds: 30 }]),
      delayFor: (ask) => (ask.scenePosition === 0 ? 1_500 : 0),
      chunk: (ask) => ({ shots: Array.from({ length: 8 }, (_, i) => fakeShot(words(`s${ask.scenePosition}i${i}`, 10))), scene_complete: true }),
    })
    const { request } = await runChain({ projectId, userId: owner.id, gateway, ledger: REAL_LEDGER, concurrency: 3 })
    const runId = (request as { runId: string }).runId

    const shots = await readChainShots(projectId)
    const byScene = (title: string) => shots.filter((s) => s.scenes!.title === title)
    expect(byScene('A').length).toBe(8)
    expect(byScene('B').length).toBe(8)
    // 45s of slots plus 50s of extras against the tier's 60s maximum: kept, for the person to
    // cut on the Workbench.
    expect(shots.reduce((sum, s) => sum + (s.duration_sec ?? 0), 0)).toBe(95)
    const chunkCalls = gateway.calls.filter((c) => c.tool === 'write_shots')
    expect(chunkCalls.map((c) => c.ask!.scenePosition).sort()).toEqual([0, 1])

    const run = await readRun(runId)
    expect(run).toMatchObject({ status: 'completed', stop_reason: null })
    for (const chunk of run.shot_run_chunks as { shots_returned: number; shots_saved: number; scene_complete: boolean }[]) {
      expect(chunk).toMatchObject({ shots_returned: 8, shots_saved: 8, scene_complete: true })
    }
    // 16 shots (32 credits) against a 16-credit hold: charged the hold.
    await expectSettledOnce(projectId, 16)
  })

  test("each chunk is told its scene's remaining slots, each with its length and word cap", async () => {
    // One 45s scene planned at the measured average: 6 slots, 8, 8, 8, 7, 7, 7 (16 or 14 words).
    const projectId = await insertChainProject(owner.id, { duration_target: '30-60s' })
    const gateway = chainGateway({
      outline: fakeOutline([{ title: 'Only', seconds: 45 }]),
      // The first answer: one shot of 21 words. The second fills the other five slots.
      chunk: (ask, n) =>
        n === 0
          ? { shots: [fakeShot(words('c0', 21))], scene_complete: false }
          : { shots: ask.slots.map((_, i) => fakeShot(words(`c1i${i}`, 4))), scene_complete: true },
    })
    await runChain({ projectId, userId: owner.id, gateway })
    const asks = gateway.calls.filter((c) => c.tool === 'write_shots').map((c) => c.ask!)
    expect(asks[0].slots).toEqual([16, 16, 16, 14, 14, 14].map((wordCap, i) => ({ seconds: i < 3 ? 8 : 7, wordCap })))
    expect(asks[1].firstSlot).toBe(2)
    expect(asks[1].slots).toEqual(asks[0].slots.slice(1))
    // The 21-word shot is over its 8s slot's 16: one rewrite, to its cap, so it keeps 8s.
    expect(gateway.calls.filter((c) => c.tool === 'rewrite_shot').map((c) => c.rewrite!.wordCap)).toEqual([16])
    expect((await readChainShots(projectId)).map((s) => s.duration_sec)).toEqual([8, 8, 8, 7, 7, 7])
  })

  test('a scene left incomplete ends the run failed/incomplete, and "Generate remaining shots" holds and writes only that scene', async () => {
    // Scene B's answer is cut short before any whole shot.
    const projectId = await insertChainProject(owner.id, { duration_target: '30-60s' })
    const outline = fakeOutline([{ title: 'A', seconds: 35, shot_count: 4 }, { title: 'B', seconds: 10, shot_count: 1 }])
    const first = await runChain({
      projectId,
      userId: owner.id,
      ledger: REAL_LEDGER,
      gateway: chainGateway({
        outline,
        chunk: (ask) =>
          ask.scenePosition === 0
            ? { shots: Array.from({ length: 4 }, (_, i) => fakeShot(words(`a${i}`, 10))), scene_complete: true }
            : { shots: [{ voice_over: 'cut off mid' }], truncated: true },
      }),
    })
    const runId = (first.request as { runId: string }).runId
    const run = await readRun(runId)
    expect(run).toMatchObject({ status: 'failed', stop_reason: 'incomplete' })
    // Retried once, then left: the retried answer settles with nothing saved, the second fails.
    const sceneB = (run.shot_run_chunks as { chunk_index: number; scene_complete: boolean; shots_saved: number; status: string }[])
      .filter((c) => c.shots_saved === 0)
      .sort((a, b) => a.chunk_index - b.chunk_index)
    expect(sceneB.map((c) => [c.status, c.scene_complete])).toEqual([
      ['succeeded', false],
      ['failed', false],
    ])

    const view = await viewOf(projectId, runId)
    expect(view.unwrittenScenes).toBe(1)
    expect(canGenerateRemaining(view)).toBe(true)
    expect(await claimState(projectId)).toBe('failed')
    expect(derivePhase({ generation: { state: 'failed' }, shotCount: 4 })).toBe('partial')

    const remainingGateway = chainGateway({
      outline,
      chunk: () => ({ shots: [fakeShot(words('b-fits', 15))], scene_complete: true }), // inside its 10s slot's 21 words
    })
    const remaining = await runChain({ projectId, userId: owner.id, gateway: remainingGateway, mode: 'remaining', ledger: REAL_LEDGER })
    expect(remaining.request.ok).toBe(true)
    expect(remainingGateway.calls.map((c) => c.ask?.scenePosition)).toEqual([1])
    const shots = await readChainShots(projectId)
    expect(shots.map((s) => s.scenes!.title)).toEqual(['A', 'A', 'A', 'A', 'B'])
    expect(await readRun((remaining.request as { runId: string }).runId)).toMatchObject({ status: 'completed' })
    expect(canGenerateRemaining(await viewOf(projectId, (remaining.request as { runId: string }).runId))).toBe(false)
    // Two held actions, each settled at its own shots: 4 then 1.
    const ledger = await holdLedger(projectId)
    expect(ledger.holds).toHaveLength(2)
    expect(ledger.net).toBe(10)
  })
})

test.describe('shot chain - a truncated chunk', () => {
  test('keeps its whole shots, drops the half-written one, and the scene continues from the last whole shot', async () => {
    const projectId = await insertChainProject(owner.id, { duration_target: '30-60s' })
    const gateway = chainGateway({
      outline: fakeOutline([{ title: 'Only', seconds: 45, shot_count: 3 }]),
      chunk: (_ask, n) =>
        n === 0
          ? {
              // Cut off inside the third shot - no scene_complete was ever written.
              shots: [fakeShot(words('t0', 10)), fakeShot(words('t1', 10)), { voice_over: 'cut off mid' }],
              truncated: true,
            }
          : { shots: [fakeShot(words('t2', 10))], scene_complete: true },
    })
    const { request, runs } = await runChain({ projectId, userId: owner.id, gateway })
    expect(runs.at(-1)!.result).toMatchObject({ outcome: 'finished', status: 'completed' })

    const shots = await readChainShots(projectId)
    expect(shots.map((s) => s.voice_over.split(' ')[0])).toEqual(['t0', 't1', 't2'])
    const chunkCalls = gateway.calls.filter((c) => c.tool === 'write_shots')
    expect(chunkCalls[1].ask!.previous).toBe(words('t1', 10))

    const run = await readRun((request as { runId: string }).runId)
    const first = (run.shot_run_chunks as { chunk_index: number; status: string; shots_saved: number; shots_returned: number; scene_complete: boolean; payload: unknown }[]).find(
      (c) => c.chunk_index === 0
    )!
    expect(first).toMatchObject({ status: 'succeeded', shots_saved: 2, shots_returned: 2, scene_complete: false, payload: null })
  })

  test('a model that always truncates before a whole shot gets 2 calls for the scene, which is left incomplete, and the run settles once', async () => {
    const projectId = await insertChainProject(owner.id, { duration_target: '30-60s' })
    const gateway = chainGateway({
      outline: fakeOutline([{ title: 'Only', seconds: 45 }]),
      chunk: () => ({ shots: [{ voice_over: 'cut off mid' }], truncated: true }),
    })
    const { request } = await runChain({ projectId, userId: owner.id, gateway, ledger: REAL_LEDGER })
    expect(gateway.calls.filter((c) => c.tool === 'write_shots')).toHaveLength(SCENE_EMPTY_ANSWER_LIMIT)
    const run = await readRun((request as { runId: string }).runId)
    expect(run).toMatchObject({ status: 'failed', stop_reason: 'incomplete' })
    const chunks = (run.shot_run_chunks as { chunk_index: number; status: string; scene_complete: boolean; shots_saved: number }[]).sort(
      (a, b) => a.chunk_index - b.chunk_index
    )
    expect(chunks.map((c) => [c.status, c.scene_complete, c.shots_saved])).toEqual([
      ['succeeded', false, 0],
      ['failed', false, 0],
    ])
    expect(canGenerateRemaining(await viewOf(projectId, run.id))).toBe(true)
    // Nothing saved: the hold is refunded whole, in one settle.
    await expectSettledOnce(projectId, 0)
    expect((await readRun(run.id)).charged_at).not.toBeNull()
  })

  test("a model that returns one shot per answer stops at the scene's request cap, keeping those shots, and the scene is left incomplete", async () => {
    // 30-60s on Wan 3.0: one scene at the 45s target. One-word shots are 2s, so the seconds
    // and shot limits never stop it - only the cap: its expected batches doubled, plus the extra.
    const projectId = await insertChainProject(owner.id, { duration_target: '30-60s' })
    const gateway = chainGateway({
      outline: fakeOutline([{ title: 'Only', seconds: 45 }]),
      chunk: (_ask, n) => ({ shots: [fakeShot(`one${n}`), { voice_over: 'cut off mid' }], truncated: true }),
    })
    const cap = chunkSizes(Math.min(Math.floor(45 / 2), shotCountFor(45))).length * SCENE_BATCH_FACTOR + SCENE_EXTRA_REQUESTS
    const { request } = await runChain({ projectId, userId: owner.id, gateway, ledger: REAL_LEDGER })
    expect(gateway.calls.filter((c) => c.tool === 'write_shots')).toHaveLength(cap)
    const shots = await readChainShots(projectId)
    expect(shots.map((s) => s.voice_over)).toEqual(Array.from({ length: cap }, (_, i) => `one${i}`))
    const run = await readRun((request as { runId: string }).runId)
    expect(run).toMatchObject({ status: 'failed', stop_reason: 'incomplete' })
    expect((run.shot_run_chunks as { scene_complete: boolean }[]).some((c) => c.scene_complete)).toBe(false)
    expect(canGenerateRemaining(await viewOf(projectId, run.id))).toBe(true)
    expect(derivePhase({ generation: { state: (await claimState(projectId))! }, shotCount: shots.length })).toBe('partial')
    await expectSettledOnce(projectId, cap * 2)
  })

  test('an answer with no whole shot is retried once: a good second answer completes the scene', async () => {
    const projectId = await insertChainProject(owner.id, { duration_target: '30-60s' })
    const gateway = chainGateway({
      outline: fakeOutline([{ title: 'Only', seconds: 45, shot_count: 2 }]),
      chunk: (_ask, n) =>
        n === 0
          ? { shots: [{ voice_over: 'cut off mid' }], truncated: true }
          : { shots: [fakeShot(words('r1', 21)), fakeShot(words('r2', 21))], scene_complete: true },
    })
    const { request } = await runChain({ projectId, userId: owner.id, gateway, ledger: REAL_LEDGER })
    expect(gateway.calls.filter((c) => c.tool === 'write_shots')).toHaveLength(2)
    expect(await readRun((request as { runId: string }).runId)).toMatchObject({ status: 'completed', stop_reason: null })
    expect((await readChainShots(projectId)).map((s) => s.voice_over.split(' ')[0])).toEqual(['r1', 'r2'])
    await expectSettledOnce(projectId, 4)
  })

  test('the two-answer limit holds across a hand-off between the attempts', async () => {
    // The first answer outlasts the run's budget, so the second comes from a continuation,
    // which must count the first rather than start the scene's count again.
    const projectId = await insertChainProject(owner.id, { duration_target: '30-60s' })
    const gateway = chainGateway({
      outline: fakeOutline([{ title: 'Only', seconds: 45 }]),
      delayFor: (_ask, n) => (n === 0 ? 5_000 : 0),
      chunk: () => ({ shots: [{ voice_over: 'cut off mid' }], truncated: true }),
    })
    const { request, runs } = await runChain({ projectId, userId: owner.id, gateway, ledger: REAL_LEDGER, runBudgetMs: 4_000 })
    expect(runs.map((r) => r.result.outcome)).toEqual(['continued', 'finished'])
    expect(gateway.calls.filter((c) => c.tool === 'write_shots')).toHaveLength(SCENE_EMPTY_ANSWER_LIMIT)
    expect(await readRun((request as { runId: string }).runId)).toMatchObject({ status: 'failed', stop_reason: 'incomplete' })
    await expectSettledOnce(projectId, 0)
  })
})

test.describe('shot chain - a scene closed without a request', () => {
  test('a scene picked up with its limits already met is marked complete with no request, and the run completes', async () => {
    // 30-60s on Wan 3.0: one 45s scene, request limit 60s. The first run writes 70s and
    // completes; with that completion cleared, "Generate remaining shots" finds the scene past
    // its limit and closes it without asking - the zero-request chunk row must land.
    const projectId = await insertChainProject(owner.id, { duration_target: '30-60s' })
    const outline = fakeOutline([{ title: 'Only', seconds: 45 }])
    await runChain({
      projectId,
      userId: owner.id,
      gateway: chainGateway({ outline, chunk: () => ({ shots: Array.from({ length: 7 }, (_, i) => fakeShot(words(`c${i}`, 21))), scene_complete: true }) }),
    })
    await admin.from('shot_run_chunks').update({ scene_complete: false }).eq('project_id', projectId)

    const gateway = chainGateway({ outline, chunk: () => ({ shots: [fakeShot('never')], scene_complete: true }) })
    const { request } = await runChain({ projectId, userId: owner.id, gateway, mode: 'remaining' })
    expect(request.ok).toBe(true)
    expect(gateway.calls.filter((c) => c.tool === 'write_shots')).toHaveLength(0)
    const run = await readRun((request as { runId: string }).runId)
    expect(run).toMatchObject({ status: 'completed', stop_reason: null })
    expect(run.shot_run_chunks).toHaveLength(1)
    expect(run.shot_run_chunks[0]).toMatchObject({ status: 'succeeded', scene_complete: true, shots_saved: 0, max_shots: 0 })
    expect(canGenerateRemaining(await viewOf(projectId, run.id))).toBe(false)
  })
})

test.describe('shot chain - the progress guard', () => {
  test('a run that saves no shot ends the chain (no_progress); the outline run counts as progress', async () => {
    const projectId = await insertChainProject(owner.id, { duration_target: '30-60s' })
    const gateway = chainGateway({
      outline: fakeOutline([{ title: 'A', seconds: 45 }]),
      chunk: () => ({ shots: [fakeShot('never')], scene_complete: true }),
    })
    // A zero budget: no run ever starts a chunk.
    const { request, runs } = await runChain({ projectId, userId: owner.id, gateway, runBudgetMs: 0 })
    expect(runs.map((r) => r.result.outcome)).toEqual(['continued', 'finished'])
    expect(await readRun((request as { runId: string }).runId)).toMatchObject({ status: 'failed', stop_reason: 'no_progress' })
    expect(gateway.calls.filter((c) => c.tool === 'write_shots')).toHaveLength(0)
  })
})

test.describe("shot chain - a run's end is safe to kill and never charged early", () => {
  const twoScenes = () =>
    chainGateway({
      outline: fakeOutline([{ title: 'A', seconds: 20, shot_count: 2 }, { title: 'B', seconds: 25, shot_count: 2 }]),
      chunk: (ask) => ({ shots: [1, 2].map((i) => fakeShot(words(`k${ask.scenePosition}i${i}`, 4))), scene_complete: true }),
    })

  test('killed mid re-order (before the one batched write lands): nothing settles or charges inside the stale window; after it, the order is fixed, the run completed and charged once', async () => {
    const projectId = await insertChainProject(owner.id, { duration_target: '30-60s' })
    const killed = faultyClient({ when: (table, op) => table === 'shots' && op === 'upsert', kill: true })
    await expect(
      runChain({ projectId, userId: owner.id, gateway: twoScenes(), ledger: REAL_LEDGER, workerClient: killed })
    ).rejects.toThrow(/killed at shots.upsert/)

    const { data: runRow } = await admin.from('shot_runs').select('id, status').eq('project_id', projectId).single()
    expect(runRow!.status).toBe('running')
    // Shots still at their provisional positions - the write landed whole or not at all.
    expect((await readChainShots(projectId)).every((s) => s.order_index >= 1_000_000)).toBe(true)

    // A page view / poll inside the stale window: no settle, no charge.
    expect((await settleDeadShotRuns(admin, REAL_LEDGER, projectId)).changed).toBe(false)
    await expectOnlyHold(projectId)
    expect(await claimState(projectId)).toBe('generating')

    await ageRun(runRow!.id)
    expect((await settleDeadShotRuns(admin, REAL_LEDGER, projectId)).changed).toBe(true)
    await settleDeadShotRuns(admin, REAL_LEDGER, projectId)
    const shots = await readChainShots(projectId)
    expect(shots.map((s) => s.order_index)).toEqual([0, 1, 2, 3])
    expect(shots.map((s) => s.scenes!.title)).toEqual(['A', 'A', 'B', 'B'])
    expect(await readRun(runRow!.id)).toMatchObject({ status: 'completed', stop_reason: null })
    await expectSettledOnce(projectId, 8)
    expect(await claimState(projectId)).toBe('succeeded')
  })

  test('killed after the run was marked terminal, before its claim and charge: completed only past the stale window, charged once', async () => {
    const projectId = await insertChainProject(owner.id, { duration_target: '30-60s' })
    // The claim's settle - not its heartbeat or the outline's payload, which carry no state.
    const killed = faultyClient({
      when: (table, op, values) => table === 'generations' && op === 'update' && Object.hasOwn(values as object, 'state'),
      kill: true,
    })
    await expect(
      runChain({ projectId, userId: owner.id, gateway: twoScenes(), ledger: REAL_LEDGER, workerClient: killed })
    ).rejects.toThrow(/killed at generations.update/)

    const { data: runRow } = await admin.from('shot_runs').select('id, status, charged_at').eq('project_id', projectId).single()
    expect(runRow).toMatchObject({ status: 'completed', charged_at: null })
    expect((await readChainShots(projectId)).map((s) => s.order_index)).toEqual([0, 1, 2, 3])

    expect((await settleDeadShotRuns(admin, REAL_LEDGER, projectId)).changed).toBe(false)
    await expectOnlyHold(projectId)

    await ageRun(runRow!.id)
    await settleDeadShotRuns(admin, REAL_LEDGER, projectId)
    await settleDeadShotRuns(admin, REAL_LEDGER, projectId)
    await expectSettledOnce(projectId, 8)
    expect(await claimState(projectId)).toBe('succeeded')
  })

  test('a poll landing while the run re-orders: no settle and no charge; the worker charges once when it finishes', async () => {
    const projectId = await insertChainProject(owner.id, { duration_target: '30-60s' })
    let polled: Promise<void> | null = null
    const slow = faultyClient({
      when: (table, op) => table === 'shots' && op === 'upsert',
      delayMs: 2_000,
      // The re-order has started: a render or a poll runs dead-chain settlement now.
      onTrigger: () => {
        polled = (async () => {
          // The Workbench's status poll, then a render's dead-chain settlement.
          const status = await loadShotsStatus({ supabase: admin, projectId, userId: owner.id, ledger: REAL_LEDGER })
          expect(status.ok && status.data.generationState).toBe('generating')
          expect(status.ok && status.data.run.status).toBe('running')
          const { changed } = await settleDeadShotRuns(admin, REAL_LEDGER, projectId)
          expect(changed).toBe(false)
          await expectOnlyHold(projectId)
          expect(await claimState(projectId)).toBe('generating')
          const { data } = await admin.from('shot_runs').select('status').eq('project_id', projectId).single()
          expect(data!.status).toBe('running')
        })()
      },
    })
    await runChain({ projectId, userId: owner.id, gateway: twoScenes(), ledger: REAL_LEDGER, workerClient: slow })
    expect(polled).not.toBeNull()
    await polled
    await expectSettledOnce(projectId, 8)
    expect(await claimState(projectId)).toBe('succeeded')
    // Once finished, the status read reports the end the client refreshes on.
    const after = await loadShotsStatus({ supabase: admin, projectId, userId: owner.id, ledger: REAL_LEDGER })
    expect(after.ok && after.data).toMatchObject({ generationState: 'succeeded', shotCount: 4, run: { status: 'completed', unwrittenScenes: 0 } })
  })
})

test.describe("shot chain - the agent's regenerate-all runs in its own invocation", () => {
  const turnUsage = { input_tokens: 400, output_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

  test('the turn hands the first run off and ends; the chain runs afterwards, past the turn, and bills the turn once', async () => {
    test.setTimeout(120_000)
    const projectId = await insertChainProject(owner.id, { duration_target: '30-60s' })
    await ensureTestCredits(owner.id)
    const started: { run: Omit<ShotsContinuationPayload, 'chainDepth'> & { chainDepth: 0 }; at: number }[] = []
    const turn = await runAgentTurn({
      config: getAgentStepConfig('workbench'),
      gateway: scriptedGateway([successMessage({}, 'regenerate_all_shots', turnUsage), textMessage('Rewriting now.', turnUsage)]),
      supabase: admin,
      projectId,
      userId: owner.id,
      content: 'start over',
      clientId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      recordTurnSpend: realRecordDynamicSpend,
      getBalance: async () => 1_000_000,
      ensureSignupGrant: async () => {},
      shotRuns: {
        ledger: REAL_LEDGER,
        start: async (run) => {
          started.push({ run, at: Date.now() })
          return true
        },
      },
    })
    const turnEndedAt = Date.now()
    expect(turn.ok).toBe(true)
    expect(started).toHaveLength(1)
    expect(started[0].run.chainDepth).toBe(0)
    // Nothing of the chain ran inside the turn: no outline yet.
    expect((await admin.from('scenes').select('id').eq('project_id', projectId)).data).toEqual([])

    const gateway = chainGateway({
      outline: fakeOutline([{ title: 'A', seconds: 45 }]),
      chunk: () => ({ shots: [fakeShot(words('g', 4))], scene_complete: true }),
    })
    await runChainFrom({ projectId, userId: owner.id, gateway, ledger: REAL_LEDGER }, started[0].run)
    expect(gateway.calls.every((c) => c.at > turnEndedAt)).toBe(true)
    const ledger = await holdLedger(projectId)
    expect(ledger.holds).toHaveLength(1)
    expect(ledger.rows.every((r) => r.operation === 'agent_turn')).toBe(true)
  })

  test('a refused start fails the run at once, writes nothing, settles its hold at only the turn, and releases the agent lock', async () => {
    const projectId = await insertChainProject(owner.id, { duration_target: '30-60s' })
    await ensureTestCredits(owner.id)
    const turn = await runAgentTurn({
      config: getAgentStepConfig('workbench'),
      gateway: scriptedGateway([successMessage({}, 'regenerate_all_shots', turnUsage), textMessage('That did not start.', turnUsage)]),
      supabase: admin,
      projectId,
      userId: owner.id,
      content: 'start over',
      clientId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      recordTurnSpend: realRecordDynamicSpend,
      getBalance: async () => 1_000_000,
      ensureSignupGrant: async () => {},
      shotRuns: { ledger: REAL_LEDGER, start: async () => false },
    })
    expect(turn.ok).toBe(true)
    const { data: runs } = await admin.from('shot_runs').select('status, stop_reason, charged_at').eq('project_id', projectId)
    expect(runs).toHaveLength(1)
    expect(runs![0]).toMatchObject({ status: 'failed', stop_reason: 'error' })
    expect(runs![0].charged_at).not.toBeNull()
    const ledger = await holdLedger(projectId)
    expect(ledger.holds).toHaveLength(1)
    expect(ledger.settles).toHaveLength(1)
    expect(ledger.rows.every((r) => r.operation === 'agent_turn')).toBe(true)
    const { data: lock } = await admin
      .from('generations')
      .select('state')
      .eq('project_id', projectId)
      .eq('operation', 'agent_turn')
      .single()
    expect(lock!.state).toBe('succeeded')
    expect(await hasLiveShotRun(admin, projectId)).toBe(false)
  })

  test('the hand-off carries the continuation secret and the deployment protection bypass, and the route accepts a first run (chainDepth 0)', async () => {
    let sent: { url: string; headers: Record<string, string>; body: unknown } | null = null
    const handOff = createShotsContinueRun({
      origin: 'https://preview.example.vercel.app',
      secret: 's'.repeat(32),
      headers: { 'x-vercel-protection-bypass': 'bypass-secret' },
      fetchImpl: async (url, init) => {
        sent = { url: String(url), headers: init!.headers as Record<string, string>, body: JSON.parse(String(init!.body)) }
        return new Response(null, { status: 202 })
      },
    })
    const projectId = crypto.randomUUID()
    const payload = { userId: crypto.randomUUID(), projectId, runId: crypto.randomUUID(), chainDepth: 0 as const }
    expect(await handOff(payload)).toBe(true)
    expect(sent!.url).toBe(`https://preview.example.vercel.app/api/projects/${projectId}/shots`)
    expect(sent!.headers['x-vercel-protection-bypass']).toBe('bypass-secret')
    expect(sent!.headers[SHOTS_INTERNAL_SECRET_HEADER]).toBe('s'.repeat(32))
    expect(parseShotsContinuationPayload(sent!.body, projectId)).toEqual(payload)
    expect(parseShotsContinuationPayload({ ...payload, chainDepth: -1 }, projectId)).toBeNull()
  })
})

test.describe('shot chain - structural edits wait for a live run', () => {
  test('while a run is writing, a shot delete and a video model change are refused; once it ends, both go through', async () => {
    const projectId = await insertChainProject(owner.id, { duration_target: '30-60s' })
    const [shotKey] = generateUniqueShotKeys(1)
    const { data: shot } = await admin
      .from('shots')
      .insert({ project_id: projectId, order_index: 0, shot_key: shotKey, voice_over: 'One.', duration_sec: 3 })
      .select('id')
      .single()
    const now = new Date().toISOString()
    const { data: run } = await admin
      .from('shot_runs')
      .insert({ project_id: projectId, attempt_id: crypto.randomUUID(), kind: 'generate', status: 'running', heartbeat_at: now, created_at: now, updated_at: now })
      .select('id')
      .single()
    const kling = { preset: 'custom', videoModel: 'kling-v3-standard', videoResolution: '720p', imageQuality: 'low', imageModel: 'gpt-image-2.5-flare' }

    expect(await deleteShotForUser(admin, shot!.id, owner.id)).toMatchObject({ success: false })
    expect(await applyProjectSettings(admin, owner.id, projectId, kling, 0)).toMatchObject({ ok: false, error: 'locked' })

    await admin.from('shot_runs').update({ status: 'completed', finished_at: now, charged_at: now }).eq('id', run!.id)
    expect(await applyProjectSettings(admin, owner.id, projectId, kling, 0)).toMatchObject({ ok: true })
    expect(await deleteShotForUser(admin, shot!.id, owner.id)).toMatchObject({ success: true })
  })
})
