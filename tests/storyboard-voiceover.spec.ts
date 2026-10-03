import { test, expect } from '@playwright/test'
import { admin, createTestSession, deleteTestUser } from './supabase-test-session'
import { primary } from './fixed-users'
import { stepIndex } from '../src/lib/config/pipeline'
import { creditsFor } from '../src/lib/config/credits'
import { VOICEOVER_VOICES } from '../src/lib/config/models'
import { buildScript, buildSpans } from '../src/lib/storyboard/voiceover'
import { VOICEOVER_ATTEMPT_DEADLINE_MS, VOICEOVER_CHUNK_CONCURRENCY } from '../src/lib/config/storyboard'
import { wordBoundaries } from '../src/lib/storyboard/motion'
import {
  runAlignRequest,
  runAlignWorker,
  runVoiceoverRequest,
  runVoiceoverWorker,
  voiceoverDir,
  type VoiceoverWorkerDeps,
} from '../src/app/api/projects/[id]/voiceover/logic'
import { deriveVoiceoverStatus, loadImageStatuses } from '../src/app/api/projects/[id]/images/status/logic'
import { fitToVoiceoverForUser, removeVoiceoverForUser } from '../src/app/(app)/projects/[id]/storyboard/actions'
import { grantAndReadBalance, realRecordFixedSpend } from './helpers/ledger-child'
import {
  SAMPLE_SECONDS,
  concurrentVoiceoverGateway,
  rateLimitedVoiceoverGateway,
  sampleAudio,
  successVoiceoverGateway,
  throwingVoiceoverGateway,
  timeoutAlignVoiceoverGateway,
} from './helpers/voiceover-fakes'
import type { getBalance as getBalanceType } from '../src/lib/credits/balance'
import type { ensureSignupGrant as ensureSignupGrantType } from '../src/lib/credits/signup-grant'

// The voiceover pipeline end to end against the real database and storage, with every
// ElevenLabs call going to a fake from tests/helpers/voiceover-fakes.ts. Nothing here can
// reach the provider.

const VOICE = VOICEOVER_VOICES.en[0].id
const SHOT_KEYS = ['bcdfg', 'hjkmn', 'pqrst', 'vwxzb', 'cdfgh', 'jkmnp']

const readBalance: typeof getBalanceType = async (userId) => {
  const { data, error } = await admin.from('credit_ledger').select('delta').eq('user_id', userId)
  if (error) throw new Error(error.message)
  return data.reduce((sum, row) => sum + row.delta, 0)
}
const ensureGrant: typeof ensureSignupGrantType = async (userId) => {
  await grantAndReadBalance(userId)
}

async function seedProject(userId: string) {
  const { data, error } = await admin
    .from('projects')
    .insert({
      user_id: userId,
      title: 'Storyboard voiceover test',
      current_step: 'storyboard',
      furthest_step: stepIndex('storyboard'),
      language: 'en',
      video_model: 'mochi-1',
    })
    .select('id')
    .single()
  expect(error).toBeNull()
  return data!.id as string
}

async function seedShots(projectId: string, narration: string[]) {
  const rows = narration.map((voice_over, i) => ({
    project_id: projectId,
    order_index: i,
    shot_key: SHOT_KEYS[i],
    voice_over,
    duration_sec: 3,
  }))
  const { data, error } = await admin.from('shots').insert(rows).select('id, order_index').order('order_index')
  expect(error).toBeNull()
  return data!.map((r) => r.id as string)
}

async function scriptFor(projectId: string) {
  const { data } = await admin.from('shots').select('id, voice_over, order_index, film_order, binned_at').eq('project_id', projectId)
  return buildScript(data ?? [])
}

async function rows(projectId: string) {
  const [gens, usage, ledger] = await Promise.all([
    admin.from('generations').select('id, operation, state, payload, error').eq('project_id', projectId),
    admin.from('usage').select('operation, status, provider, model, quantity, unit, estimated_cost').eq('project_id', projectId),
    admin.from('credit_ledger').select('delta, operation, attempt_id').eq('project_id', projectId),
  ])
  return { gens: gens.data ?? [], usage: usage.data ?? [], ledger: ledger.data ?? [] }
}

async function projectVoiceover(projectId: string) {
  const { data } = await admin
    .from('projects')
    .select(
      'audio_path, voiceover_alignment_path, voice_id, language_code, tts_model, total_duration_sec, voiceover_source, voiceover_generated_at, voiceover_muted, voiceover_spans, voiceover_words'
    )
    .eq('id', projectId)
    .single()
  return data!
}

function deps(gateway: VoiceoverWorkerDeps['gateway']): VoiceoverWorkerDeps {
  return { supabase: admin, gateway, recordFixedSpend: realRecordFixedSpend }
}

async function requestGenerate(userId: string, projectId: string, expectedCredits?: number) {
  const script = await scriptFor(projectId)
  return runVoiceoverRequest({
    supabase: admin,
    projectId,
    userId,
    voiceId: VOICE,
    expectedCredits: expectedCredits ?? creditsFor({ step: 'storyboard', operation: 'voiceover', quantity: script.text.length }),
    getBalance: readBalance,
    ensureSignupGrant: ensureGrant,
    mintAttemptId: () => crypto.randomUUID(),
  })
}

async function generate(userId: string, projectId: string, gateway: VoiceoverWorkerDeps['gateway']) {
  const req = await requestGenerate(userId, projectId)
  expect(req.ok).toBe(true)
  if (!req.ok) throw new Error('request failed')
  const outcome = await runVoiceoverWorker(deps(gateway), { userId, projectId, generationId: req.generationId })
  return { req, outcome }
}

async function listVoiceoverFiles(userId: string, projectId: string) {
  const { data } = await admin.storage.from('artifacts').list(voiceoverDir(userId, projectId))
  return (data ?? []).map((f) => f.name)
}

test.describe('voiceover - generate', () => {
  test.setTimeout(120000)

  test('402 when the balance is short writes no generations, usage or ledger row', async () => {
    const { user } = await createTestSession()
    try {
      const projectId = await seedProject(user.id)
      await seedShots(projectId, ['A sentence to read.'])
      const balance = await grantAndReadBalance(user.id)
      await admin.from('credit_ledger').insert({
        user_id: user.id,
        kind: 'spend',
        delta: -balance,
        step: 'workbench',
        operation: 'generate_shots',
        attempt_id: crypto.randomUUID(),
        dedupe_key: `test-drain:${crypto.randomUUID()}`,
        price_version: 'test',
        pricing_mode: 'fixed',
      })
      const result = await requestGenerate(user.id, projectId)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.status).toBe(402)
      const after = await rows(projectId)
      expect(after.gens).toHaveLength(0)
      expect(after.usage).toHaveLength(0)
      expect(after.ledger).toHaveLength(0)
    } finally {
      await deleteTestUser(user.id)
    }
  })

  test('a price the page did not show is refused with the real price, and nothing is written', async () => {
    const projectId = await seedProject(primary.user.id)
    await seedShots(projectId, ['A sentence to read.'])
    const result = await requestGenerate(primary.user.id, projectId, 9999)
    expect(result).toMatchObject({ ok: false, status: 409, code: 'price_changed' })
    const after = await rows(projectId)
    expect(after.gens).toHaveLength(0)
    expect(after.ledger).toHaveLength(0)
  })

  test('success reads the whole script once, stores the read and its alignment, links it, and charges per character once', async () => {
    const projectId = await seedProject(primary.user.id)
    const shotIds = await seedShots(projectId, ['The river rises.', 'The city wakes.'])
    const script = await scriptFor(projectId)
    const gateway = successVoiceoverGateway()
    const { outcome } = await generate(primary.user.id, projectId, gateway)
    expect(outcome).toEqual({ ok: true })

    expect(gateway.synthesizeCalls).toHaveLength(1)
    expect(gateway.synthesizeCalls[0]).toMatchObject({ text: 'The river rises. The city wakes.', voiceId: VOICE, languageCode: 'en' })

    const after = await rows(projectId)
    const price = creditsFor({ step: 'storyboard', operation: 'voiceover', quantity: script.text.length })
    expect(after.ledger).toHaveLength(1)
    expect(after.ledger[0]).toMatchObject({ delta: -price, operation: 'voiceover' })
    expect(after.usage).toHaveLength(1)
    expect(after.usage[0]).toMatchObject({ status: 'succeeded', provider: 'elevenlabs', unit: 'characters', quantity: script.text.length })
    expect(after.gens[0]).toMatchObject({ state: 'succeeded', payload: null })

    const vo = await projectVoiceover(projectId)
    const attemptId = after.ledger[0].attempt_id
    expect(vo.audio_path).toBe(`${voiceoverDir(primary.user.id, projectId)}/${attemptId}.mp3`)
    expect(vo.voiceover_alignment_path).toBe(`${voiceoverDir(primary.user.id, projectId)}/${attemptId}.alignment.json`)
    expect(vo).toMatchObject({ voice_id: VOICE, language_code: 'en', voiceover_source: 'generated', voiceover_muted: false })
    expect(vo.total_duration_sec).toBeCloseTo(SAMPLE_SECONDS, 3)
    const spans = vo.voiceover_spans as { shotId: string; text: string; startSec: number; endSec: number }[]
    expect(spans.map((s) => [s.shotId, s.text])).toEqual([
      [shotIds[0], 'The river rises.'],
      [shotIds[1], 'The city wakes.'],
    ])
    expect(spans[0].endSec).toBeLessThanOrEqual(spans[1].startSec)
    // The word boundaries are computed once, here at settle: one pair per spoken word, in order.
    const words = vo.voiceover_words as [number, number][]
    expect(words).toHaveLength(script.text.split(' ').length)
    words.forEach(([start, end], i) => {
      expect(start).toBeLessThanOrEqual(end)
      if (i > 0) expect(start).toBeGreaterThanOrEqual(words[i - 1][1])
    })

    const files = await listVoiceoverFiles(primary.user.id, projectId)
    expect(files).toContain(`${attemptId}.mp3`)
    expect(files).toContain(`${attemptId}.alignment.json`)
  })

  test('a failed read is not charged and leaves the project without a voiceover', async () => {
    const projectId = await seedProject(primary.user.id)
    await seedShots(projectId, ['A sentence to read.'])
    const { outcome } = await generate(primary.user.id, projectId, throwingVoiceoverGateway())
    expect(outcome.ok).toBe(false)
    const after = await rows(projectId)
    expect(after.ledger).toHaveLength(0)
    expect(after.gens[0].state).toBe('failed')
    expect(after.usage).toHaveLength(1)
    expect(after.usage[0].status).toBe('failed')
    expect((await projectVoiceover(projectId)).audio_path).toBeNull()
  })

  test('a long script is read in parts; a failure mid-chain charges nothing and a retry resumes only the missing part', async () => {
    const projectId = await seedProject(primary.user.id)
    const long = (word: string) => Array.from({ length: 700 }, () => word).join(' ') + '.'
    await seedShots(projectId, [long('alpha'), long('bravo')])
    const script = await scriptFor(projectId)
    expect(script.text.length).toBeGreaterThan(5000)

    const failing = successVoiceoverGateway({ failSynthesizeOnCall: 2 })
    const first = await generate(primary.user.id, projectId, failing)
    expect(first.outcome.ok).toBe(false)
    expect(failing.synthesizeCalls).toHaveLength(2)
    expect((await rows(projectId)).ledger).toHaveLength(0)

    const retry = successVoiceoverGateway()
    const second = await generate(primary.user.id, projectId, retry)
    expect(second.outcome).toEqual({ ok: true })
    // Part one was paid for in the failed run and is reused, never read again.
    expect(retry.synthesizeCalls).toHaveLength(1)
    expect(retry.synthesizeCalls[0].text).toBe(failing.synthesizeCalls[1].text)

    const after = await rows(projectId)
    expect(after.ledger).toHaveLength(1)
    expect(after.ledger[0].delta).toBe(-creditsFor({ step: 'storyboard', operation: 'voiceover', quantity: script.text.length }))
    const vo = await projectVoiceover(projectId)
    expect(vo.total_duration_sec).toBeCloseTo(SAMPLE_SECONDS * 2, 3)
    const spans = vo.voiceover_spans as { startSec: number }[]
    expect(spans[1].startSec).toBeGreaterThanOrEqual(SAMPLE_SECONDS - 0.001)
  })

  test('parts split at shot boundaries are read concurrently up to the cap; a failed part keeps the others paid and a retry reads only it', async () => {
    const projectId = await seedProject(primary.user.id)
    // ~3,000 characters each: no two fit one 5,000-character request, so each shot is its own part.
    const narration = ['alpha', 'bravo', 'charlie'].map((word) => Array.from({ length: 500 }, () => word).join(' ') + '.')
    await seedShots(projectId, narration)

    expect(VOICEOVER_CHUNK_CONCURRENCY).toBe(2)
    const failing = concurrentVoiceoverGateway({ holdUntil: 3, failWhen: (text) => text.startsWith('bravo') })
    const first = await generate(primary.user.id, projectId, failing)
    expect(first.outcome.ok).toBe(false)
    // Never more than the cap in flight, and each part was exactly one shot's narration.
    expect(failing.peakInFlight()).toBe(VOICEOVER_CHUNK_CONCURRENCY)
    expect(failing.synthesizeCalls.map((c) => c.text).sort()).toEqual([...narration].sort())

    const afterFail = await rows(projectId)
    expect(afterFail.ledger).toHaveLength(0)
    expect(afterFail.gens[0].state).toBe('failed')
    expect(afterFail.usage.map((u) => u.status).sort()).toEqual(['failed', 'succeeded', 'succeeded'])
    // Both paid parts persisted around the failed middle one.
    const parts = (afterFail.gens[0].payload as { parts: (object | null)[] }).parts
    expect(parts[0]).not.toBeNull()
    expect(parts[1] ?? null).toBeNull()
    expect(parts[2]).not.toBeNull()

    const retry = successVoiceoverGateway()
    const second = await generate(primary.user.id, projectId, retry)
    expect(second.outcome).toEqual({ ok: true })
    expect(retry.synthesizeCalls.map((c) => c.text)).toEqual([narration[1]])

    const after = await rows(projectId)
    expect(after.ledger).toHaveLength(1)
    const vo = await projectVoiceover(projectId)
    expect(vo.total_duration_sec).toBeCloseTo(SAMPLE_SECONDS * 3, 3)
    const spans = vo.voiceover_spans as { startSec: number }[]
    expect(spans[1].startSec).toBeGreaterThanOrEqual(SAMPLE_SECONDS - 0.001)
    expect(spans[2].startSec).toBeGreaterThanOrEqual(SAMPLE_SECONDS * 2 - 0.001)
  })

  test('a 429 is retried after a backoff and the read completes, charged once', async () => {
    const projectId = await seedProject(primary.user.id)
    await seedShots(projectId, ['The river rises. The city wakes.'])
    const gateway = rateLimitedVoiceoverGateway(2)
    const req = await requestGenerate(primary.user.id, projectId)
    if (!req.ok) throw new Error('request failed')
    const outcome = await runVoiceoverWorker(
      { ...deps(gateway), rateLimitBackoffMs: [10, 10, 10] },
      { userId: primary.user.id, projectId, generationId: req.generationId }
    )
    expect(outcome).toEqual({ ok: true })
    expect(gateway.synthesizeCalls).toHaveLength(3)
    const after = await rows(projectId)
    expect(after.usage).toEqual([expect.objectContaining({ status: 'succeeded' })])
    expect(after.ledger).toHaveLength(1)
  })

  test('429s past the last backoff fail the read uncharged and resumable', async () => {
    const projectId = await seedProject(primary.user.id)
    await seedShots(projectId, ['The river rises. The city wakes.'])
    const gateway = rateLimitedVoiceoverGateway(10)
    const req = await requestGenerate(primary.user.id, projectId)
    if (!req.ok) throw new Error('request failed')
    const outcome = await runVoiceoverWorker(
      { ...deps(gateway), rateLimitBackoffMs: [10, 10] },
      { userId: primary.user.id, projectId, generationId: req.generationId }
    )
    expect(outcome.ok).toBe(false)
    expect(gateway.synthesizeCalls).toHaveLength(3)
    const after = await rows(projectId)
    expect(after.ledger).toHaveLength(0)
    expect(after.gens[0].state).toBe('failed')
    const retry = await generate(primary.user.id, projectId, successVoiceoverGateway())
    expect(retry.outcome).toEqual({ ok: true })
  })

  test('no attempt starts past the deadline: an unreached part is not called or reserved, and stays resumable', async () => {
    expect(VOICEOVER_ATTEMPT_DEADLINE_MS).toBe(145_000)
    const projectId = await seedProject(primary.user.id)
    await seedShots(projectId, ['The river rises.'])
    const gateway = successVoiceoverGateway()
    const req = await requestGenerate(primary.user.id, projectId)
    if (!req.ok) throw new Error('request failed')
    const outcome = await runVoiceoverWorker(
      { ...deps(gateway), attemptDeadlineMs: -1 },
      { userId: primary.user.id, projectId, generationId: req.generationId }
    )
    expect(outcome.ok).toBe(false)
    expect(gateway.synthesizeCalls).toHaveLength(0)
    const after = await rows(projectId)
    expect(after.usage).toHaveLength(0)
    expect(after.ledger).toHaveLength(0)
    expect(after.gens[0].state).toBe('failed')
  })

  test('Remove nulls the current voiceover but keeps its files', async () => {
    const projectId = await seedProject(primary.user.id)
    await seedShots(projectId, ['Keep the files.'])
    await generate(primary.user.id, projectId, successVoiceoverGateway())
    const before = await listVoiceoverFiles(primary.user.id, projectId)
    expect(before.length).toBeGreaterThan(0)

    const result = await removeVoiceoverForUser(admin, primary.user.id, projectId)
    expect(result.success).toBe(true)
    const vo = await projectVoiceover(projectId)
    expect(vo).toMatchObject({
      audio_path: null,
      voiceover_alignment_path: null,
      voice_id: null,
      voiceover_source: null,
      voiceover_generated_at: null,
      voiceover_spans: null,
      voiceover_words: null,
    })
    expect(await listVoiceoverFiles(primary.user.id, projectId)).toEqual(before)
  })
})

test.describe('voiceover - upload and align', () => {
  test.setTimeout(120000)

  async function uploadSample(userId: string, projectId: string) {
    const attemptId = crypto.randomUUID()
    const { error } = await admin.storage
      .from('artifacts')
      .upload(`${voiceoverDir(userId, projectId)}/${attemptId}.mp3`, sampleAudio(), { contentType: 'audio/mpeg' })
    expect(error).toBeNull()
    return attemptId
  }

  function requestAlign(userId: string, projectId: string, attemptId: string, expectedCredits: number) {
    return runAlignRequest({
      supabase: admin,
      projectId,
      userId,
      attemptId,
      ext: 'mp3',
      expectedCredits,
      getBalance: readBalance,
      ensureSignupGrant: ensureGrant,
    })
  }

  test('an aligned upload is priced per minute of measured audio, charged once, and links like a generated read', async () => {
    const projectId = await seedProject(primary.user.id)
    await seedShots(projectId, ['The river rises.', 'The city wakes.'])
    const attemptId = await uploadSample(primary.user.id, projectId)
    const price = creditsFor({ step: 'storyboard', operation: 'align_voiceover', quantity: SAMPLE_SECONDS })

    const req = await requestAlign(primary.user.id, projectId, attemptId, price)
    expect(req.ok).toBe(true)
    if (!req.ok) return
    const gateway = successVoiceoverGateway()
    const outcome = await runAlignWorker(deps(gateway), {
      userId: primary.user.id,
      projectId,
      generationId: req.generationId,
      audio: req.audio,
    })
    expect(outcome).toEqual({ ok: true })
    expect(gateway.alignCalls).toHaveLength(1)
    expect(gateway.alignCalls[0].text).toBe('The river rises. The city wakes.')

    const after = await rows(projectId)
    expect(after.ledger).toHaveLength(1)
    expect(after.ledger[0]).toMatchObject({ delta: -price, operation: 'align_voiceover', attempt_id: attemptId })
    expect(after.usage[0]).toMatchObject({ status: 'succeeded', unit: 'seconds' })
    const vo = await projectVoiceover(projectId)
    expect(vo).toMatchObject({ voiceover_source: 'uploaded', voice_id: null, tts_model: null })
    expect(vo.audio_path).toBe(`${voiceoverDir(primary.user.id, projectId)}/${attemptId}.mp3`)
    expect((vo.voiceover_spans as unknown[]).length).toBe(2)
    expect((vo.voiceover_words as unknown[]).length).toBe('The river rises. The city wakes.'.split(' ').length)
  })

  test('RECOVER: an alignment already stored relinks without a call and takes its word boundaries from the stored file', async () => {
    const projectId = await seedProject(primary.user.id)
    await seedShots(projectId, ['The river rises.', 'The city wakes.'])
    const attemptId = await uploadSample(primary.user.id, projectId)
    const price = creditsFor({ step: 'storyboard', operation: 'align_voiceover', quantity: SAMPLE_SECONDS })
    const req = await requestAlign(primary.user.id, projectId, attemptId, price)
    expect(req.ok).toBe(true)
    if (!req.ok) return

    // An earlier run was paid, stored its alignment and persisted it, then died before linking.
    const script = await scriptFor(projectId)
    const alignment = {
      characters: script.text.split(''),
      character_start_times_seconds: script.text.split('').map((_, i) => i * 0.1),
      character_end_times_seconds: script.text.split('').map((_, i) => (i + 1) * 0.1),
    }
    const spans = buildSpans(script, alignment)
    const alignmentPath = `${voiceoverDir(primary.user.id, projectId)}/${attemptId}.alignment.json`
    await admin.storage
      .from('artifacts')
      .upload(alignmentPath, JSON.stringify({ text: script.text, alignment, spans }), { contentType: 'application/json' })
    const { data: gen } = await admin.from('generations').select('payload').eq('id', req.generationId).single()
    await admin
      .from('generations')
      .update({ payload: { ...(gen!.payload as Record<string, unknown>), alignmentPath, spans } })
      .eq('id', req.generationId)

    const gateway = throwingVoiceoverGateway()
    const outcome = await runAlignWorker(deps(gateway), {
      userId: primary.user.id,
      projectId,
      generationId: req.generationId,
      audio: req.audio,
    })
    expect(outcome).toEqual({ ok: true })
    expect(gateway.alignCalls).toHaveLength(0)
    const vo = await projectVoiceover(projectId)
    expect(vo.voiceover_alignment_path).toBe(alignmentPath)
    expect(vo.voiceover_words).toEqual(wordBoundaries(alignment))
  })

  test('a failed alignment is not charged and keeps the uploaded file', async () => {
    const projectId = await seedProject(primary.user.id)
    await seedShots(projectId, ['The river rises.'])
    const attemptId = await uploadSample(primary.user.id, projectId)
    const price = creditsFor({ step: 'storyboard', operation: 'align_voiceover', quantity: SAMPLE_SECONDS })
    const req = await requestAlign(primary.user.id, projectId, attemptId, price)
    expect(req.ok).toBe(true)
    if (!req.ok) return
    const outcome = await runAlignWorker(deps(throwingVoiceoverGateway()), {
      userId: primary.user.id,
      projectId,
      generationId: req.generationId,
      audio: req.audio,
    })
    expect(outcome.ok).toBe(false)
    const after = await rows(projectId)
    expect(after.ledger).toHaveLength(0)
    expect(after.gens[0].state).toBe('failed')
    expect(await listVoiceoverFiles(primary.user.id, projectId)).toContain(`${attemptId}.mp3`)
    expect((await projectVoiceover(projectId)).audio_path).toBeNull()

    // The status read offers Try again on the same file, with its price.
    const status = await loadImageStatuses({ supabase: admin, projectId, userId: primary.user.id, getBalance: readBalance })
    expect(status.ok).toBe(true)
    if (status.ok) {
      expect(status.data.voiceover).toMatchObject({ state: 'failed', mode: 'upload' })
      expect(status.data.voiceover.retryUpload).toMatchObject({ attemptId, ext: 'mp3' })
    }
  })
})

test.describe('voiceover - alignment timeout', () => {
  test.setTimeout(120000)

  test('an alignment past the provider timeout settles usage failed, writes no ledger row, and releases the claim for Try again', async () => {
    const projectId = await seedProject(primary.user.id)
    await seedShots(projectId, ['The tide turns.'])
    const attemptId = crypto.randomUUID()
    const { error } = await admin.storage
      .from('artifacts')
      .upload(`${voiceoverDir(primary.user.id, projectId)}/${attemptId}.mp3`, sampleAudio(), { contentType: 'audio/mpeg' })
    expect(error).toBeNull()
    const price = creditsFor({ step: 'storyboard', operation: 'align_voiceover', quantity: SAMPLE_SECONDS })
    const align = () =>
      runAlignRequest({
        supabase: admin,
        projectId,
        userId: primary.user.id,
        attemptId,
        ext: 'mp3',
        expectedCredits: price,
        getBalance: readBalance,
        ensureSignupGrant: ensureGrant,
      })

    const req = await align()
    if (!req.ok) throw new Error('request failed')
    const outcome = await runAlignWorker(deps(timeoutAlignVoiceoverGateway()), {
      userId: primary.user.id,
      projectId,
      generationId: req.generationId,
      audio: req.audio,
    })
    expect(outcome.ok).toBe(false)

    const after = await rows(projectId)
    expect(after.usage).toEqual([expect.objectContaining({ operation: 'align_voiceover', status: 'failed' })])
    expect(after.ledger).toHaveLength(0)
    expect(after.gens[0].state).toBe('failed')

    const status = await loadImageStatuses({ supabase: admin, projectId, userId: primary.user.id, getBalance: readBalance })
    if (!status.ok) throw new Error('status failed')
    expect(status.data.voiceover).toMatchObject({ state: 'failed', mode: 'upload' })
    expect(status.data.voiceover.retryUpload).toMatchObject({ attemptId, ext: 'mp3' })

    // Released at once, not after a stale window: Try again claims straight away.
    const again = await align()
    expect(again.ok).toBe(true)
  })
})

test.describe('voiceover - Fit to voiceover (server)', () => {
  test.setTimeout(120000)

  test('writes film lengths from the read; refused while the read is stale', async () => {
    const projectId = await seedProject(primary.user.id)
    const shotIds = await seedShots(projectId, ['The river rises.', 'The city wakes.'])
    await generate(primary.user.id, projectId, successVoiceoverGateway())

    const fit = await fitToVoiceoverForUser(admin, primary.user.id, projectId)
    expect(fit.success).toBe(true)
    const { data: shots } = await admin.from('shots').select('id, film_duration_sec').in('id', shotIds)
    const total = (shots ?? []).reduce((sum, s) => sum + (s.film_duration_sec ?? 0), 0)
    // Two shots of at least the 1s minimum tile the ~3.4s read.
    expect(total).toBeCloseTo(Math.round(SAMPLE_SECONDS * 10) / 10, 1)

    await admin.from('shots').update({ binned_at: new Date().toISOString() }).eq('id', shotIds[1])
    const refused = await fitToVoiceoverForUser(admin, primary.user.id, projectId)
    expect(refused).toMatchObject({ success: false })
  })

  test('uses the true spans, past the video model’s clip limit, clamping only at 30s', async () => {
    // mochi-1 clips top out at 5.4s; the storyboard ignores that.
    const projectId = await seedProject(primary.user.id)
    const narration = ['The river rises.', 'The city wakes.', 'The night falls.']
    const shotIds = await seedShots(projectId, narration)
    const bounds = [0, 14, 20, 60]
    await admin
      .from('projects')
      .update({
        audio_path: `${primary.user.id}/${projectId}/voiceover/long.mp3`,
        total_duration_sec: 60,
        voiceover_spans: shotIds.map((shotId, i) => ({
          shotId,
          from: 0,
          to: narration[i].length,
          text: narration[i],
          startSec: bounds[i],
          endSec: bounds[i + 1],
        })),
      })
      .eq('id', projectId)

    const fit = await fitToVoiceoverForUser(admin, primary.user.id, projectId)
    expect(fit).toMatchObject({ success: true, clamped: [shotIds[2]] })
    const { data: shots } = await admin.from('shots').select('id, film_duration_sec').in('id', shotIds)
    const byId = new Map((shots ?? []).map((r) => [r.id, r.film_duration_sec]))
    expect(shotIds.map((id) => byId.get(id))).toEqual([14, 6, 30])
  })
})

test.describe('voiceover - status derivation', () => {
  const read = {
    audio_path: 'u/p/voiceover/a.mp3',
    voice_id: VOICE,
    language_code: 'en',
    total_duration_sec: 3,
    voiceover_source: 'generated',
    voiceover_generated_at: '2026-09-25T10:00:00Z',
    voiceover_muted: false,
    voiceover_spans: [{ shotId: 's', from: 0, to: 1, text: 'x', startSec: 0, endSec: 1 }],
  }
  const none = { ...read, audio_path: null, voiceover_generated_at: null, voiceover_spans: null, voiceover_source: null }

  test('none, present, and an in-flight claim reading as generating', () => {
    const now = Date.parse('2026-09-25T10:05:00Z')
    expect(deriveVoiceoverStatus(none, [], null, now).state).toBe('none')
    expect(deriveVoiceoverStatus(read, [], 'url', now)).toMatchObject({ state: 'present', current: { audioUrl: 'url' } })
    const live = {
      operation: 'voiceover',
      state: 'generating',
      started_at: '2026-09-25T10:04:30Z',
      queued_at: null,
      updated_at: '2026-09-25T10:04:30Z',
      payload: { voiceId: VOICE, chars: 120 },
    }
    expect(deriveVoiceoverStatus(read, [live], 'url', now)).toMatchObject({ state: 'generating', attemptChars: 120 })
  })

  test('a failed latest attempt reads as failed; a success after it does not', () => {
    const now = Date.parse('2026-09-25T10:05:00Z')
    const failed = {
      operation: 'voiceover',
      state: 'failed',
      started_at: null,
      queued_at: null,
      updated_at: '2026-09-25T10:03:00Z',
      payload: { voiceId: VOICE },
    }
    expect(deriveVoiceoverStatus(none, [failed], null, now).state).toBe('failed')
    const laterSuccess = { ...failed, operation: 'align_voiceover', state: 'succeeded', updated_at: '2026-09-25T10:04:00Z' }
    expect(deriveVoiceoverStatus(read, [failed, laterSuccess], null, now).state).toBe('present')
  })
})
