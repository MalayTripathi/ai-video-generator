import { test, expect } from '@playwright/test'
import { admin, createFreshUser, releaseTestUser } from './supabase-test-session'
import {
  REAL_SHOT_LEDGER,
  chainGateway,
  faultyClient,
  fakeOutline,
  fakeShot,
  holdLedger,
  insertChainProject,
  readChainShots,
  readRun,
  runChain,
} from './helpers/shot-chain'
import { shotGenerationCredits } from '../src/lib/config/credits'

// Layer: api. Code-owned shot slots through the whole chain, every provider call a fake: each
// written shot takes its scene's next slot (fewer than asked continue into the rest; extras
// take later slots), one rewrite per over-cap shot, lengthened or flagged when still over -
// never a shot dropped - a replay never paying for a rewrite twice, and a button run's
// charge capped at its hold.

const words = (tag: string, n: number) => [tag, ...Array.from({ length: n - 1 }, (_, i) => `w${i}`)].join(' ')
// Four spoken words: 4 / 2.17 + 0.25 = 2.09s -> 3s on Wan 3.0, inside every slot's cap here.
const four = (tag: string) => words(tag, 4)

let owner: { id: string }
test.beforeEach(async () => {
  owner = await createFreshUser()
})
test.afterEach(async () => {
  await releaseTestUser(owner.id)
})

async function usageRows(projectId: string) {
  const { data, error } = await admin.from('usage').select('operation, generation_id, message_id, status').eq('project_id', projectId)
  expect(error).toBeNull()
  return data ?? []
}

test.describe('shot slots - code owns how many shots and how long', () => {
  test("the outline's count becomes the scene's slots; each shot takes its slot's length, whatever its words", { tag: '@smoke' }, async () => {
    // 30-60s on Wan 3.0: one 45s scene proposed as 5 shots -> five 9s slots, 18 words each.
    const projectId = await insertChainProject(owner.id, { duration_target: '30-60s' })
    const gateway = chainGateway({
      outline: fakeOutline([{ title: 'Only', seconds: 45, shot_count: 5 }]),
      chunk: () => ({ shots: [1, 2, 3, 4, 5].map((i) => fakeShot(four(`s${i}`))), scene_complete: true }),
    })
    const { request } = await runChain({ projectId, userId: owner.id, gateway })
    const asks = gateway.calls.filter((c) => c.tool === 'write_shots')
    expect(asks).toHaveLength(1)
    expect(asks[0].ask!.maxShots).toBe(5)
    expect(asks[0].ask!.slots).toEqual(Array.from({ length: 5 }, () => ({ seconds: 9, wordCap: 18 })))
    const { data: scene } = await admin.from('scenes').select('slot_seconds').eq('project_id', projectId).single()
    expect(scene!.slot_seconds).toEqual([9, 9, 9, 9, 9])
    const shots = await readChainShots(projectId)
    expect(shots.map((s) => s.duration_sec)).toEqual([9, 9, 9, 9, 9])
    expect((await readRun((request as { runId: string }).runId)).status).toBe('completed')
  })

  test('fewer shots than slots: the next request asks for exactly the unfilled ones, whatever the model said', async () => {
    const projectId = await insertChainProject(owner.id, { duration_target: '30-60s' })
    const gateway = chainGateway({
      outline: fakeOutline([{ title: 'Only', seconds: 45, shot_count: 5 }]),
      // The first answer says the scene is done after 3 of its 5 slots.
      chunk: (_ask, n) =>
        n === 0
          ? { shots: [1, 2, 3].map((i) => fakeShot(four(`a${i}`))), scene_complete: true }
          : { shots: [4, 5].map((i) => fakeShot(four(`b${i}`))), scene_complete: true },
    })
    const { request } = await runChain({ projectId, userId: owner.id, gateway })
    const asks = gateway.calls.filter((c) => c.tool === 'write_shots').map((c) => c.ask!)
    expect(asks.map((a) => [a.firstSlot, a.maxShots])).toEqual([
      [1, 5],
      [4, 2],
    ])
    expect(asks[1].previous).toBe(four('a3'))
    const shots = await readChainShots(projectId)
    expect(shots.map((s) => s.voice_over.split(' ')[0])).toEqual(['a1', 'a2', 'a3', 'b4', 'b5'])
    expect(shots.map((s) => s.duration_sec)).toEqual([9, 9, 9, 9, 9])
    expect((await readRun((request as { runId: string }).runId)).status).toBe('completed')
  })

  test("extras take the scene's later slots - word-checked against that slot's cap - and only extras past the last slot keep their words' length", async () => {
    // One 45s scene as 10 slots: 5, 5, 5, 5, 5, 4, 4, 4, 4, 4 (a 4s slot holds 8 words). The
    // first request asks for 8 and gets 9 - the ninth, at 20 words, takes slot 9 and is
    // rewritten to its cap. The second asks for slot 10 alone and gets 3: two past the last slot.
    const projectId = await insertChainProject(owner.id, { duration_target: '30-60s' })
    const warnings: string[] = []
    const warn = console.warn
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '))
      warn(...args)
    }
    try {
      const gateway = chainGateway({
        outline: fakeOutline([{ title: 'Only', seconds: 45, shot_count: 10 }]),
        chunk: (_ask, n) =>
          n === 0
            ? { shots: [...[1, 2, 3, 4, 5, 6, 7, 8].map((i) => fakeShot(four(`a${i}`))), fakeShot(words('long', 20))], scene_complete: false }
            : { shots: [10, 11, 12].map((i) => fakeShot(four(`b${i}`))), scene_complete: true },
      })
      await runChain({ projectId, userId: owner.id, gateway })
      const asks = gateway.calls.filter((c) => c.tool === 'write_shots').map((c) => c.ask!)
      expect(asks.map((a) => [a.firstSlot, a.maxShots])).toEqual([
        [1, 8],
        [10, 1],
      ])
      const rewrites = gateway.calls.filter((c) => c.tool === 'rewrite_shot')
      expect(rewrites.map((r) => r.rewrite)).toEqual([{ voiceOver: words('long', 20), wordCap: 8, words: 20 }])
      const shots = await readChainShots(projectId)
      // Every shot returned is saved: 9 + 3.
      expect(shots).toHaveLength(12)
      expect(shots.map((s) => s.duration_sec)).toEqual([5, 5, 5, 5, 5, 4, 4, 4, 4, 4, 3, 3])
      expect(shots[8].voice_over).toBe(words('long', 8))
      expect(warnings.some((w) => w.includes(`shots_past_last_slot project=${projectId} scene=0 count=2`))).toBe(true)
    } finally {
      console.warn = warn
    }
  })
})

test.describe('one rewrite per over-cap shot', () => {
  test('exactly one rewrite call per over-cap shot; fits -> its slot; still over -> lengthened; past the model maximum -> flagged; none dropped', async () => {
    // Five 9s slots (18 words each) on Wan 3.0 (2-30s).
    const projectId = await insertChainProject(owner.id, { duration_target: '30-60s' })
    const gateway = chainGateway({
      outline: fakeOutline([{ title: 'Only', seconds: 45, shot_count: 5 }]),
      chunk: () => ({
        shots: [fakeShot(four('ok')), fakeShot(words('fit', 30)), fakeShot(words('still', 30)), fakeShot(words('huge', 80)), fakeShot(four('end'))],
        scene_complete: true,
      }),
      rewrite: (ask) => {
        const tag = ask.voiceOver.split(' ')[0]
        if (tag === 'fit') return { voice_over: words('fit', 10), dialogue: [] }
        if (tag === 'huge') return { voice_over: words('huge', 79), dialogue: [] }
        return { voice_over: ask.voiceOver, dialogue: [] } // no shorter: kept as written
      },
    })
    await runChain({ projectId, userId: owner.id, gateway })

    const rewrites = gateway.calls.filter((c) => c.tool === 'rewrite_shot').map((c) => c.rewrite!.voiceOver.split(' ')[0])
    expect(rewrites.sort()).toEqual(['fit', 'huge', 'still'])
    const shots = await readChainShots(projectId)
    expect(shots.map((s) => s.voice_over.split(' ')[0])).toEqual(['ok', 'fit', 'still', 'huge', 'end'])
    expect(shots[1].voice_over).toBe(words('fit', 10))
    // 30 words: 30 / 2.17 + 0.25 = 14.07 -> 15s. 79 words need 36.7s: Wan 3.0's 30s, flagged.
    expect(shots.map((s) => s.duration_sec)).toEqual([9, 9, 15, 30, 9])
    expect(shots.map((s) => s.narration_overflow)).toEqual([false, false, false, true, false])

    // Each rewrite wrote its own usage row, on the run's claim, with no message (a button run).
    const usage = await usageRows(projectId)
    expect(usage).toHaveLength(gateway.calls.length)
    expect(usage).toHaveLength(1 + 1 + 3)
    expect(usage.every((u) => u.operation === 'generate_shots' && u.generation_id !== null && u.message_id === null)).toBe(true)
  })

  test('a replayed chunk reuses its stored rewrite - never a second rewrite call', async () => {
    const projectId = await insertChainProject(owner.id, { duration_target: '30-60s' })
    const gateway = chainGateway({
      outline: fakeOutline([{ title: 'Only', seconds: 45, shot_count: 5 }]),
      chunk: () => ({ shots: [fakeShot(words('fit', 30)), ...[2, 3, 4, 5].map((i) => fakeShot(four(`s${i}`)))], scene_complete: true }),
      rewrite: () => ({ voice_over: words('fit', 10), dialogue: [] }),
    })
    // The shots' write fails after the rewrite was paid for and stored: the chunk fails with
    // its payload - rewrite included - left for a replay.
    const failingWrite = faultyClient({ when: (table, op) => table === 'shots' && op === 'insert', kill: true })
    const first = await runChain({ projectId, userId: owner.id, gateway, workerClient: failingWrite })
    expect(first.runs.at(-1)!.result).toMatchObject({ outcome: 'finished', status: 'failed' })
    expect(gateway.calls.filter((c) => c.tool === 'rewrite_shot')).toHaveLength(1)
    const { data: stored } = await admin.from('shot_run_chunks').select('payload').eq('project_id', projectId).not('payload', 'is', null)
    expect((stored ?? []).map((c) => Object.keys((c.payload as { rewrites?: object }).rewrites ?? {}))).toEqual([['0']])

    await runChain({ projectId, userId: owner.id, gateway, mode: 'remaining' })
    expect(gateway.calls.filter((c) => c.tool === 'write_shots')).toHaveLength(1)
    expect(gateway.calls.filter((c) => c.tool === 'rewrite_shot')).toHaveLength(1)
    const shots = await readChainShots(projectId)
    expect(shots).toHaveLength(5)
    expect(shots[0].voice_over).toBe(words('fit', 10))
    expect(shots.map((s) => s.duration_sec)).toEqual([9, 9, 9, 9, 9])
  })
})

test.describe('a button run is charged at most its hold', () => {
  test('20 slots on a 16-credit hold: the run writes all 20, never reads the balance past the hold, and is charged 16', async () => {
    // 30-60s: the hold is 8 shots (60s at the measured 8.45s average) = 16 credits. The outline
    // asks for 20 shots in 45s on Wan 3.0 (2s or 3s each) - 40 credits at the per-shot price.
    const projectId = await insertChainProject(owner.id, { duration_target: '30-60s' })
    expect(shotGenerationCredits('30-60s')).toBe(16)
    const gateway = chainGateway({
      outline: fakeOutline([{ title: 'Only', seconds: 45, shot_count: 20 }]),
      chunk: (ask) => ({ shots: ask.slots.map((_, i) => fakeShot(`two words${ask.firstSlot + i}`)), scene_complete: true }),
    })
    // The request reads a full balance; any read after it - a past-the-hold check - would see none.
    let reads = 0
    const { request } = await runChain({
      projectId,
      userId: owner.id,
      gateway,
      ledger: REAL_SHOT_LEDGER,
      balance: () => (reads++ === 0 ? 1_000_000 : 0),
    })
    expect(reads).toBe(1)
    expect((await readRun((request as { runId: string }).runId)).status).toBe('completed')
    expect(await readChainShots(projectId)).toHaveLength(20)
    const ledger = await holdLedger(projectId)
    expect(ledger.holds.map((h) => h.delta)).toEqual([-16])
    expect(ledger.settles).toHaveLength(0)
    expect(ledger.net).toBe(16)
  })
})
