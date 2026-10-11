import { test, expect } from '@playwright/test'
import { admin } from './supabase-test-session'
import { primary } from './fixed-users'
import { realRecordDynamicSpend, realRecordFixedSpend } from './helpers/ledger-child'
import { scriptedGateway, successMessage, textMessage } from './helpers/claude-fakes'
import {
  chainGateway,
  fakeOutline,
  fakeShot,
  faultyClient,
  insertChainProject,
  readChainShots,
  readRun,
  runChain,
  runChainFrom,
} from './helpers/shot-chain'
import { hasLiveShotRun, settleDeadShotRuns, type ShotRunLedger } from '../src/lib/shots/runs'
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

// Layer: api. Task 4b's shot-chain guarantees, against the database with fake gateways:
// every outline scene is written into its own reserved seconds, a run is 'completed' only
// when every scene is, discarded output is recorded, the progress guard replaces the chain
// limit, a truncated chunk keeps its whole shots, and a run's end is safe to kill and never
// settled or charged by a request landing while it is still writing.

const REAL_LEDGER: ShotRunLedger = { recordFixedSpend: realRecordFixedSpend, recordDynamicSpend: realRecordDynamicSpend }

/** Spoken text of `n` words. On Wan 3.0: 1 word -> 2s, 10 -> 5s, 21 -> 10s, 32 -> 15s. */
const words = (tag: string, n: number) => [tag, ...Array.from({ length: n - 1 }, (_, i) => `w${i}`)].join(' ')

async function ledgerRows(projectId: string) {
  const { data, error } = await admin.from('credit_ledger').select('delta, operation').eq('project_id', projectId)
  expect(error).toBeNull()
  return data ?? []
}

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

test.describe('shot chain - the 300-shot ceiling', () => {
  for (const sceneCount of [1, 2]) {
    test(`a ${sceneCount}-scene project at the 300-shot ceiling completes across many runs`, async () => {
      test.setTimeout(600_000)
      // 8-10 min on Wan 3.0 (2s minimum): ceiling 600 / 2 = 300 shots. One-word shots are 2s.
      const projectId = await insertChainProject(primary.user.id, { duration_target: '8-10min' })
      const outline = fakeOutline(Array.from({ length: sceneCount }, (_, i) => ({ title: `S${i}`, seconds: 600 / sceneCount })))
      const gateway = chainGateway({
        outline,
        chunk: (ask, n) => ({
          shots: Array.from({ length: 8 }, (_, i) => fakeShot(`s${ask.scenePosition}c${n}i${i}`)),
          scene_complete: false, // never says it is done - its seconds end it
        }),
      })
      const { request, runs } = await runChain({
        projectId,
        userId: primary.user.id,
        gateway,
        ledger: REAL_LEDGER,
        runBudgetMs: 3_000,
      })
      expect(request.ok).toBe(true)
      // More runs than the old fixed chain limit of 16 would ever have allowed for one scene.
      expect(runs.length).toBeGreaterThan(sceneCount === 1 ? 2 : 1)
      expect(runs.at(-1)!.result).toMatchObject({ outcome: 'finished', status: 'completed' })

      const shots = await readChainShots(projectId)
      expect(shots.length).toBe(300)
      expect(shots.map((s) => s.order_index)).toEqual(Array.from({ length: 300 }, (_, i) => i))
      expect(shots.reduce((sum, s) => sum + (s.duration_sec ?? 0), 0)).toBe(600)
      expect(await ledgerRows(projectId)).toEqual([{ delta: -600, operation: 'generate_shots' }])
      expect(await claimState(projectId)).toBe('succeeded')
    })
  }
})

test.describe('shot chain - every scene gets its reserved seconds', () => {
  test('parallel chunks finishing out of scene order: the later scene cannot take the earlier one\'s seconds', async () => {
    // 30-60s on Wan 3.0: two scenes of 30s, nothing unreserved. Ten-word shots are 5s, and
    // each chunk returns 8 of them (40s) - a scene keeps 6 (30s). Scene B finishes first.
    const projectId = await insertChainProject(primary.user.id, { duration_target: '30-60s' })
    const gateway = chainGateway({
      outline: fakeOutline([{ title: 'A', seconds: 30 }, { title: 'B', seconds: 30 }]),
      delayFor: (ask) => (ask.scenePosition === 0 ? 1_500 : 0),
      chunk: (ask) => ({ shots: Array.from({ length: 8 }, (_, i) => fakeShot(words(`s${ask.scenePosition}i${i}`, 10))), scene_complete: true }),
    })
    const { request } = await runChain({ projectId, userId: primary.user.id, gateway, ledger: REAL_LEDGER, concurrency: 3 })
    const runId = (request as { runId: string }).runId

    const shots = await readChainShots(projectId)
    const byScene = (title: string) => shots.filter((s) => s.scenes!.title === title)
    expect(byScene('A').length).toBe(6)
    expect(byScene('B').length).toBe(6)
    expect(byScene('A').reduce((sum, s) => sum + (s.duration_sec ?? 0), 0)).toBe(30)
    expect(byScene('B').reduce((sum, s) => sum + (s.duration_sec ?? 0), 0)).toBe(30)
    // B's chunk was answered first.
    const chunkCalls = gateway.calls.filter((c) => c.tool === 'write_shots')
    expect(chunkCalls.map((c) => c.ask!.scenePosition).sort()).toEqual([0, 1])

    // Discarded output is recorded per chunk: 8 returned, 6 accepted.
    const run = await readRun(runId)
    expect(run).toMatchObject({ status: 'completed', stop_reason: null })
    for (const chunk of run.shot_run_chunks as { shots_returned: number; shots_saved: number; scene_complete: boolean }[]) {
      expect(chunk).toMatchObject({ shots_returned: 8, shots_saved: 6, scene_complete: true })
    }
  })

  test("each chunk is told its scene's word budget: the scene's remaining seconds at the spoken pace", async () => {
    const projectId = await insertChainProject(primary.user.id, { duration_target: '30-60s' })
    const gateway = chainGateway({
      outline: fakeOutline([{ title: 'Only', seconds: 45 }]),
      chunk: (_ask, n) => ({ shots: [fakeShot(words(`c${n}`, 21))], scene_complete: n > 0 }), // one 10s shot each
    })
    const budgets: number[] = []
    const recording = {
      async createMessage(p: Parameters<typeof gateway.createMessage>[0]) {
        const text = String((p.messages[0] as { content: unknown }).content)
        const m = /about (\d+) words in total/.exec(text)
        if (m) budgets.push(Number(m[1]))
        return gateway.createMessage(p)
      },
    }
    await runChain({ projectId, userId: primary.user.id, gateway: recording })
    // 45s, then 35s left after the first 10s shot: x 2.17 words/s x 0.9.
    expect(budgets).toEqual([Math.floor(45 * 2.17 * 0.9), Math.floor(35 * 2.17 * 0.9)])
  })

  test('a scene no shot fits is never marked complete, the run ends failed/incomplete, and "Generate remaining shots" writes only that scene', async () => {
    // 50s + 10s = the tier's 60s, nothing unreserved. Scene B's only shot is 15s.
    const projectId = await insertChainProject(primary.user.id, { duration_target: '30-60s' })
    const outline = fakeOutline([{ title: 'A', seconds: 50 }, { title: 'B', seconds: 10 }])
    const first = await runChain({
      projectId,
      userId: primary.user.id,
      ledger: REAL_LEDGER,
      gateway: chainGateway({
        outline,
        chunk: (ask) =>
          ask.scenePosition === 0
            ? { shots: Array.from({ length: 5 }, (_, i) => fakeShot(words(`a${i}`, 21))), scene_complete: true }
            : { shots: [fakeShot(words('b-too-long', 32))], scene_complete: true },
      }),
    })
    const runId = (first.request as { runId: string }).runId
    const run = await readRun(runId)
    expect(run).toMatchObject({ status: 'failed', stop_reason: 'incomplete' })
    const sceneB = (run.shot_run_chunks as { scene_complete: boolean; shots_saved: number; shots_returned: number; status: string; error: string | null }[]).find(
      (c) => c.shots_saved === 0
    )!
    expect(sceneB).toMatchObject({ scene_complete: false, shots_returned: 1, status: 'failed' })
    expect(sceneB.error).toContain("No shot fitted")

    const view = await viewOf(projectId, runId)
    expect(view.unwrittenScenes).toBe(1)
    expect(canGenerateRemaining(view)).toBe(true)
    expect(await claimState(projectId)).toBe('failed')
    expect(derivePhase({ generation: { state: 'failed' }, shotCount: 5 })).toBe('partial')

    const remainingGateway = chainGateway({
      outline,
      chunk: () => ({ shots: [fakeShot(words('b-fits', 15))], scene_complete: true }), // 7.16 -> 8s
    })
    const remaining = await runChain({ projectId, userId: primary.user.id, gateway: remainingGateway, mode: 'remaining', ledger: REAL_LEDGER })
    expect(remaining.request.ok).toBe(true)
    // Only scene B was asked for.
    expect(remainingGateway.calls.map((c) => c.ask?.scenePosition)).toEqual([1])
    const shots = await readChainShots(projectId)
    expect(shots.map((s) => s.scenes!.title)).toEqual(['A', 'A', 'A', 'A', 'A', 'B'])
    expect(await readRun((remaining.request as { runId: string }).runId)).toMatchObject({ status: 'completed' })
    expect(canGenerateRemaining(await viewOf(projectId, (remaining.request as { runId: string }).runId))).toBe(false)
    expect((await ledgerRows(projectId)).map((r) => r.delta).sort()).toEqual([-10, -2])
  })
})

test.describe('shot chain - a truncated chunk', () => {
  test('keeps its whole shots, drops the half-written one, and the scene continues from the last whole shot', async () => {
    const projectId = await insertChainProject(primary.user.id, { duration_target: '30-60s' })
    const gateway = chainGateway({
      outline: fakeOutline([{ title: 'Only', seconds: 45 }]),
      chunk: (_ask, n) =>
        n === 0
          ? {
              // Cut off inside the third shot - no scene_complete was ever written.
              shots: [fakeShot(words('t0', 10)), fakeShot(words('t1', 10)), { voice_over: 'cut off mid' }],
              truncated: true,
            }
          : { shots: [fakeShot(words('t2', 10))], scene_complete: true },
    })
    const { request, runs } = await runChain({ projectId, userId: primary.user.id, gateway })
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

  test('cut short before any whole shot: the scene is left incomplete, never complete, for Generate remaining shots', async () => {
    const projectId = await insertChainProject(primary.user.id, { duration_target: '30-60s' })
    const gateway = chainGateway({
      outline: fakeOutline([{ title: 'Only', seconds: 45 }]),
      chunk: () => ({ shots: [{ voice_over: 'cut off mid' }], truncated: true }),
    })
    const { request } = await runChain({ projectId, userId: primary.user.id, gateway })
    const run = await readRun((request as { runId: string }).runId)
    expect(run).toMatchObject({ status: 'failed', stop_reason: 'incomplete' })
    expect(run.shot_run_chunks).toHaveLength(1)
    expect(run.shot_run_chunks[0]).toMatchObject({ status: 'failed', scene_complete: false, shots_saved: 0 })
    expect(canGenerateRemaining(await viewOf(projectId, run.id))).toBe(true)
  })
})

test.describe('shot chain - the progress guard', () => {
  test('a run that saves no shot ends the chain (no_progress); the outline run counts as progress', async () => {
    const projectId = await insertChainProject(primary.user.id, { duration_target: '30-60s' })
    const gateway = chainGateway({
      outline: fakeOutline([{ title: 'A', seconds: 45 }]),
      chunk: () => ({ shots: [fakeShot('never')], scene_complete: true }),
    })
    // A zero budget: no run ever starts a chunk.
    const { request, runs } = await runChain({ projectId, userId: primary.user.id, gateway, runBudgetMs: 0 })
    expect(runs.map((r) => r.result.outcome)).toEqual(['continued', 'finished'])
    expect(await readRun((request as { runId: string }).runId)).toMatchObject({ status: 'failed', stop_reason: 'no_progress' })
    expect(gateway.calls.filter((c) => c.tool === 'write_shots')).toHaveLength(0)
  })
})

test.describe("shot chain - a run's end is safe to kill and never charged early", () => {
  const twoScenes = () =>
    chainGateway({
      outline: fakeOutline([{ title: 'A', seconds: 20 }, { title: 'B', seconds: 25 }]),
      chunk: (ask) => ({ shots: [1, 2].map((i) => fakeShot(words(`k${ask.scenePosition}i${i}`, 4))), scene_complete: true }),
    })

  test('killed mid re-order (before the one batched write lands): nothing settles or charges inside the stale window; after it, the order is fixed, the run completed and charged once', async () => {
    const projectId = await insertChainProject(primary.user.id, { duration_target: '30-60s' })
    const killed = faultyClient({ when: (table, op) => table === 'shots' && op === 'upsert', kill: true })
    await expect(
      runChain({ projectId, userId: primary.user.id, gateway: twoScenes(), ledger: REAL_LEDGER, workerClient: killed })
    ).rejects.toThrow(/killed at shots.upsert/)

    const { data: runRow } = await admin.from('shot_runs').select('id, status').eq('project_id', projectId).single()
    expect(runRow!.status).toBe('running')
    // Shots still at their provisional positions - the write landed whole or not at all.
    expect((await readChainShots(projectId)).every((s) => s.order_index >= 1_000_000)).toBe(true)

    // A page view / poll inside the stale window: no settle, no charge.
    expect((await settleDeadShotRuns(admin, REAL_LEDGER, projectId)).changed).toBe(false)
    expect(await ledgerRows(projectId)).toHaveLength(0)
    expect(await claimState(projectId)).toBe('generating')

    await ageRun(runRow!.id)
    expect((await settleDeadShotRuns(admin, REAL_LEDGER, projectId)).changed).toBe(true)
    await settleDeadShotRuns(admin, REAL_LEDGER, projectId)
    const shots = await readChainShots(projectId)
    expect(shots.map((s) => s.order_index)).toEqual([0, 1, 2, 3])
    expect(shots.map((s) => s.scenes!.title)).toEqual(['A', 'A', 'B', 'B'])
    expect(await readRun(runRow!.id)).toMatchObject({ status: 'completed', stop_reason: null })
    expect(await ledgerRows(projectId)).toEqual([{ delta: -8, operation: 'generate_shots' }])
    expect(await claimState(projectId)).toBe('succeeded')
  })

  test('killed after the run was marked terminal, before its claim and charge: completed only past the stale window, charged once', async () => {
    const projectId = await insertChainProject(primary.user.id, { duration_target: '30-60s' })
    // The claim's settle - not its heartbeat or the outline's payload, which carry no state.
    const killed = faultyClient({
      when: (table, op, values) => table === 'generations' && op === 'update' && Object.hasOwn(values as object, 'state'),
      kill: true,
    })
    await expect(
      runChain({ projectId, userId: primary.user.id, gateway: twoScenes(), ledger: REAL_LEDGER, workerClient: killed })
    ).rejects.toThrow(/killed at generations.update/)

    const { data: runRow } = await admin.from('shot_runs').select('id, status, charged_at').eq('project_id', projectId).single()
    expect(runRow).toMatchObject({ status: 'completed', charged_at: null })
    expect((await readChainShots(projectId)).map((s) => s.order_index)).toEqual([0, 1, 2, 3])

    expect((await settleDeadShotRuns(admin, REAL_LEDGER, projectId)).changed).toBe(false)
    expect(await ledgerRows(projectId)).toHaveLength(0)

    await ageRun(runRow!.id)
    await settleDeadShotRuns(admin, REAL_LEDGER, projectId)
    await settleDeadShotRuns(admin, REAL_LEDGER, projectId)
    expect(await ledgerRows(projectId)).toEqual([{ delta: -8, operation: 'generate_shots' }])
    expect(await claimState(projectId)).toBe('succeeded')
  })

  test('a poll landing while the run re-orders: no settle and no charge; the worker charges once when it finishes', async () => {
    const projectId = await insertChainProject(primary.user.id, { duration_target: '30-60s' })
    let polled: Promise<void> | null = null
    const slow = faultyClient({
      when: (table, op) => table === 'shots' && op === 'upsert',
      delayMs: 2_000,
      // The re-order has started: a render or a poll runs dead-chain settlement now.
      onTrigger: () => {
        polled = (async () => {
          // The Workbench's status poll, then a render's dead-chain settlement.
          const status = await loadShotsStatus({ supabase: admin, projectId, userId: primary.user.id, ledger: REAL_LEDGER })
          expect(status.ok && status.data.generationState).toBe('generating')
          expect(status.ok && status.data.run.status).toBe('running')
          const { changed } = await settleDeadShotRuns(admin, REAL_LEDGER, projectId)
          expect(changed).toBe(false)
          expect(await ledgerRows(projectId)).toHaveLength(0)
          expect(await claimState(projectId)).toBe('generating')
          const { data } = await admin.from('shot_runs').select('status').eq('project_id', projectId).single()
          expect(data!.status).toBe('running')
        })()
      },
    })
    await runChain({ projectId, userId: primary.user.id, gateway: twoScenes(), ledger: REAL_LEDGER, workerClient: slow })
    expect(polled).not.toBeNull()
    await polled
    expect(await ledgerRows(projectId)).toEqual([{ delta: -8, operation: 'generate_shots' }])
    expect(await claimState(projectId)).toBe('succeeded')
    // Once finished, the status read reports the end the client refreshes on.
    const after = await loadShotsStatus({ supabase: admin, projectId, userId: primary.user.id, ledger: REAL_LEDGER })
    expect(after.ok && after.data).toMatchObject({ generationState: 'succeeded', shotCount: 4, run: { status: 'completed', unwrittenScenes: 0 } })
  })
})

test.describe("shot chain - the agent's regenerate-all runs in its own invocation", () => {
  const turnUsage = { input_tokens: 400, output_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

  test('the turn hands the first run off and ends; the chain runs afterwards, past the turn, and bills the turn once', async () => {
    test.setTimeout(120_000)
    const projectId = await insertChainProject(primary.user.id, { duration_target: '30-60s' })
    const started: { run: Omit<ShotsContinuationPayload, 'chainDepth'> & { chainDepth: 0 }; at: number }[] = []
    const turn = await runAgentTurn({
      config: getAgentStepConfig('workbench'),
      gateway: scriptedGateway([successMessage({}, 'regenerate_all_shots', turnUsage), textMessage('Rewriting now.', turnUsage)]),
      supabase: admin,
      projectId,
      userId: primary.user.id,
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
    await runChainFrom({ projectId, userId: primary.user.id, gateway, ledger: REAL_LEDGER }, started[0].run)
    expect(gateway.calls.every((c) => c.at > turnEndedAt)).toBe(true)
    const ledger = await ledgerRows(projectId)
    expect(ledger).toHaveLength(1)
    expect(ledger[0].operation).toBe('agent_turn')
  })

  test('a refused start fails the run at once, writes nothing, bills only the turn, and releases the agent lock', async () => {
    const projectId = await insertChainProject(primary.user.id, { duration_target: '30-60s' })
    const turn = await runAgentTurn({
      config: getAgentStepConfig('workbench'),
      gateway: scriptedGateway([successMessage({}, 'regenerate_all_shots', turnUsage), textMessage('That did not start.', turnUsage)]),
      supabase: admin,
      projectId,
      userId: primary.user.id,
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
    expect(await ledgerRows(projectId)).toEqual([expect.objectContaining({ operation: 'agent_turn' })])
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
    const projectId = await insertChainProject(primary.user.id, { duration_target: '30-60s' })
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

    expect(await deleteShotForUser(admin, shot!.id, primary.user.id)).toMatchObject({ success: false })
    expect(await applyProjectSettings(admin, primary.user.id, projectId, kling, 0)).toMatchObject({ ok: false, error: 'locked' })

    await admin.from('shot_runs').update({ status: 'completed', finished_at: now, charged_at: now }).eq('id', run!.id)
    expect(await applyProjectSettings(admin, primary.user.id, projectId, kling, 0)).toMatchObject({ ok: true })
    expect(await deleteShotForUser(admin, shot!.id, primary.user.id)).toMatchObject({ success: true })
  })
})
