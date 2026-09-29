import { test, expect } from '@playwright/test'
import { admin, createTestSession, deleteTestUser } from './supabase-test-session'
import { primary } from './fixed-users'
import { stepIndex } from '../src/lib/config/pipeline'
import { creditsFor } from '../src/lib/config/credits'
import { MUSIC_MIN_SEC, MUSIC_UPLOAD_MAX_SEC } from '../src/lib/config/storyboard'
import {
  musicDir,
  runMusicPromptDerivation,
  runMusicRequest,
  runMusicUploadRequest,
  runMusicWorker,
  type MusicWorkerDeps,
} from '../src/app/api/projects/[id]/music/logic'
import { loadImageStatuses } from '../src/app/api/projects/[id]/images/status/logic'
import {
  removeMusicForUser,
  saveMusicStylePromptForUser,
  setMusicLoopForUser,
  setMusicMutedForUser,
} from '../src/app/(app)/projects/[id]/storyboard/actions'
import { grantAndReadBalance, realRecordFixedSpend } from './helpers/ledger-child'
import { SAMPLE_SECONDS, sampleAudio } from './helpers/voiceover-fakes'
import { successMusicGateway, throwingMusicGateway } from './helpers/music-fakes'
import { scriptedGateway, successMessage, throwingGateway } from './helpers/claude-fakes'
import type { getBalance as getBalanceType } from '../src/lib/credits/balance'
import type { ensureSignupGrant as ensureSignupGrantType } from '../src/lib/credits/signup-grant'

// The music pipeline end to end against the real database and storage. Every ElevenLabs
// call goes to a fake from tests/helpers/music-fakes.ts and every Claude call to a fake from
// tests/helpers/claude-fakes.ts - nothing here can reach a provider.

const SHOT_KEYS = ['bcdfg', 'hjkmn', 'pqrst', 'vwxzb', 'cdfgh', 'jkmnp']

const readBalance: typeof getBalanceType = async (userId) => {
  const { data, error } = await admin.from('credit_ledger').select('delta').eq('user_id', userId)
  if (error) throw new Error(error.message)
  return data.reduce((sum, row) => sum + row.delta, 0)
}
const ensureGrant: typeof ensureSignupGrantType = async (userId) => {
  await grantAndReadBalance(userId)
}

async function seedProject(userId: string, stylePrompt: string | null = 'Soft piano, hopeful, slow') {
  const { data, error } = await admin
    .from('projects')
    .insert({
      user_id: userId,
      title: 'Storyboard music test',
      current_step: 'storyboard',
      furthest_step: stepIndex('storyboard'),
      language: 'en',
      video_model: 'mochi-1',
      music_style_prompt: stylePrompt,
    })
    .select('id')
    .single()
  expect(error).toBeNull()
  return data!.id as string
}

async function seedShots(projectId: string, durations: number[], narration: string[] = []) {
  const rows = durations.map((duration_sec, i) => ({
    project_id: projectId,
    order_index: i,
    shot_key: SHOT_KEYS[i],
    voice_over: narration[i] ?? '',
    visual_description: `A still of scene ${i + 1}`,
    duration_sec,
  }))
  const { data, error } = await admin.from('shots').insert(rows).select('id, order_index').order('order_index')
  expect(error).toBeNull()
  return data!.map((r) => r.id as string)
}

async function rows(projectId: string) {
  const [gens, usage, ledger] = await Promise.all([
    admin.from('generations').select('id, operation, state, payload').eq('project_id', projectId),
    admin.from('usage').select('operation, status, provider, quantity, unit').eq('project_id', projectId),
    admin.from('credit_ledger').select('delta, operation, attempt_id').eq('project_id', projectId),
  ])
  return { gens: gens.data ?? [], usage: usage.data ?? [], ledger: ledger.data ?? [] }
}

async function projectMusic(projectId: string) {
  const { data } = await admin
    .from('projects')
    .select('music_path, music_duration_sec, music_source, music_style_prompt, music_generated_at, music_loop, music_muted')
    .eq('id', projectId)
    .single()
  return data!
}

function deps(gateway: MusicWorkerDeps['gateway']): MusicWorkerDeps {
  return { supabase: admin, gateway, recordFixedSpend: realRecordFixedSpend }
}

function priceFor(pictureSec: number) {
  return creditsFor({ step: 'storyboard', operation: 'background_music', quantity: pictureSec })
}

async function request(userId: string, projectId: string, expectedCredits: number) {
  return runMusicRequest({
    supabase: admin,
    projectId,
    userId,
    expectedCredits,
    getBalance: readBalance,
    ensureSignupGrant: ensureGrant,
    mintAttemptId: () => crypto.randomUUID(),
  })
}

async function listMusicFiles(userId: string, projectId: string) {
  const { data } = await admin.storage.from('artifacts').list(musicDir(userId, projectId))
  return (data ?? []).map((f) => f.name)
}

test.describe('music - generate', () => {
  test.setTimeout(120000)

  test('402 when the balance is short writes no generations, usage or ledger row', async () => {
    const { user } = await createTestSession()
    try {
      const projectId = await seedProject(user.id)
      await seedShots(projectId, [10, 10])
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
      const result = await request(user.id, projectId, priceFor(20))
      expect(result).toMatchObject({ ok: false, status: 402 })
      const after = await rows(projectId)
      expect(after.gens).toHaveLength(0)
      expect(after.usage).toHaveLength(0)
      expect(after.ledger).toHaveLength(0)
    } finally {
      await deleteTestUser(user.id)
    }
  })

  test('the requested length follows the picture, is priced per minute, and is charged once on success', async () => {
    const projectId = await seedProject(primary.user.id)
    await seedShots(projectId, [12, 13.5])
    // A price for a different length is refused with the real one.
    expect(await request(primary.user.id, projectId, 9999)).toMatchObject({ ok: false, status: 409, code: 'price_changed' })

    const req = await request(primary.user.id, projectId, priceFor(25.5))
    expect(req.ok).toBe(true)
    if (!req.ok) throw new Error('request failed')
    const gateway = successMusicGateway()
    expect(await runMusicWorker(deps(gateway), { userId: primary.user.id, projectId, generationId: req.generationId })).toEqual({ ok: true })

    expect(gateway.composeCalls).toEqual([{ prompt: 'Soft piano, hopeful, slow', lengthMs: 25500, model: expect.any(String) }])
    const after = await rows(projectId)
    expect(after.ledger).toHaveLength(1)
    expect(after.ledger[0]).toMatchObject({ delta: -priceFor(25.5), operation: 'background_music' })
    expect(after.usage).toEqual([expect.objectContaining({ operation: 'background_music', status: 'succeeded', provider: 'elevenlabs', unit: 'seconds', quantity: 25.5 })])
    expect(after.gens).toEqual([expect.objectContaining({ operation: 'background_music', state: 'succeeded', payload: null })])

    const music = await projectMusic(projectId)
    expect(music.music_path).toBe(`${musicDir(primary.user.id, projectId)}/${after.ledger[0].attempt_id}.mp3`)
    expect(music).toMatchObject({ music_source: 'generated', music_loop: false })
    expect(Number(music.music_duration_sec)).toBeCloseTo(SAMPLE_SECONDS, 3)
    expect(await listMusicFiles(primary.user.id, projectId)).toContain(`${after.ledger[0].attempt_id}.mp3`)
  })

  test('a picture shorter than the provider minimum requests the minimum', async () => {
    const projectId = await seedProject(primary.user.id)
    await seedShots(projectId, [1])
    const req = await request(primary.user.id, projectId, priceFor(MUSIC_MIN_SEC))
    expect(req.ok).toBe(true)
    if (!req.ok) throw new Error('request failed')
    const gateway = successMusicGateway()
    await runMusicWorker(deps(gateway), { userId: primary.user.id, projectId, generationId: req.generationId })
    expect(gateway.composeCalls[0].lengthMs).toBe(MUSIC_MIN_SEC * 1000)
  })

  test('a failed run is not charged, keeps the style prompt, and reads as failed', async () => {
    const projectId = await seedProject(primary.user.id)
    await seedShots(projectId, [10])
    const req = await request(primary.user.id, projectId, priceFor(10))
    if (!req.ok) throw new Error('request failed')
    const outcome = await runMusicWorker(deps(throwingMusicGateway()), { userId: primary.user.id, projectId, generationId: req.generationId })
    expect(outcome.ok).toBe(false)
    const after = await rows(projectId)
    expect(after.ledger).toHaveLength(0)
    expect(after.usage).toEqual([expect.objectContaining({ status: 'failed' })])
    expect(after.gens[0]).toMatchObject({ state: 'failed' })
    const music = await projectMusic(projectId)
    expect(music).toMatchObject({ music_path: null, music_style_prompt: 'Soft piano, hopeful, slow' })
    const status = await loadImageStatuses({ supabase: admin, projectId, userId: primary.user.id, getBalance: readBalance })
    if (!status.ok) throw new Error('status failed')
    expect(status.data.music).toMatchObject({ state: 'failed', attemptSec: 10 })
  })

  test('with no style prompt nothing is claimed', async () => {
    const projectId = await seedProject(primary.user.id, null)
    await seedShots(projectId, [10])
    expect(await request(primary.user.id, projectId, priceFor(10))).toMatchObject({ ok: false, status: 422, code: 'empty' })
    expect((await rows(projectId)).gens).toHaveLength(0)
  })
})

test.describe('music - style prompt derivation', () => {
  test.setTimeout(60000)

  test('runs once per project, from the narration, writes usage but no ledger row', async () => {
    const projectId = await seedProject(primary.user.id, null)
    await seedShots(projectId, [5, 5], ['The river rises at dawn.', 'The city wakes.'])
    const gateway = scriptedGateway([successMessage({ style: 'Low strings and soft piano, hopeful, slow' }, 'write_music_style')])

    const first = await runMusicPromptDerivation({ supabase: admin, gateway, projectId, userId: primary.user.id })
    expect(first).toEqual({ ok: true, status: 200, prompt: 'Low strings and soft piano, hopeful, slow' })
    expect(gateway.getCallCount()).toBe(1)
    const system = JSON.stringify(gateway.getCalls()[0].system)
    expect(system).toContain('The river rises at dawn. The city wakes.')

    // A reload or re-expand: the stored prompt comes back, no second call.
    const second = await runMusicPromptDerivation({ supabase: admin, gateway, projectId, userId: primary.user.id })
    expect(second).toMatchObject({ ok: true, prompt: 'Low strings and soft piano, hopeful, slow' })
    expect(gateway.getCallCount()).toBe(1)

    // Even with the field emptied, the claim refuses a second derivation.
    await saveMusicStylePromptForUser(admin, primary.user.id, projectId, '')
    const third = await runMusicPromptDerivation({ supabase: admin, gateway, projectId, userId: primary.user.id })
    expect(third).toMatchObject({ ok: true, prompt: null })
    expect(gateway.getCallCount()).toBe(1)

    const after = await rows(projectId)
    expect(after.usage).toEqual([expect.objectContaining({ operation: 'derive_music_prompt', status: 'succeeded', provider: 'anthropic' })])
    expect(after.ledger).toHaveLength(0)
  })

  test('falls back to shot descriptions when there is no narration', async () => {
    const projectId = await seedProject(primary.user.id, null)
    await seedShots(projectId, [5, 5])
    const gateway = scriptedGateway([successMessage({ style: 'Ambient pads, calm, slow' }, 'write_music_style')])
    await runMusicPromptDerivation({ supabase: admin, gateway, projectId, userId: primary.user.id })
    expect(JSON.stringify(gateway.getCalls()[0].system)).toContain('A still of scene 1')
  })

  test('on failure the field stays empty and nothing retries automatically', async () => {
    const projectId = await seedProject(primary.user.id, null)
    await seedShots(projectId, [5], ['A line.'])
    const failed = await runMusicPromptDerivation({ supabase: admin, gateway: throwingGateway(), projectId, userId: primary.user.id })
    expect(failed.ok).toBe(false)
    expect((await projectMusic(projectId)).music_style_prompt).toBeNull()

    const gateway = scriptedGateway([successMessage({ style: 'Never used' }, 'write_music_style')])
    const again = await runMusicPromptDerivation({ supabase: admin, gateway, projectId, userId: primary.user.id })
    expect(again).toMatchObject({ ok: true, prompt: null })
    expect(gateway.getCallCount()).toBe(0)
    expect((await rows(projectId)).ledger).toHaveLength(0)
  })

  test('a prompt the person already wrote is never derived over', async () => {
    const projectId = await seedProject(primary.user.id, 'My own prompt')
    await seedShots(projectId, [5], ['A line.'])
    const gateway = scriptedGateway([successMessage({ style: 'Other' }, 'write_music_style')])
    const result = await runMusicPromptDerivation({ supabase: admin, gateway, projectId, userId: primary.user.id })
    expect(result).toMatchObject({ ok: true, prompt: 'My own prompt' })
    expect(gateway.getCallCount()).toBe(0)
    expect((await rows(projectId)).gens).toHaveLength(0)
  })
})

test.describe('music - upload, loop, mute, remove', () => {
  test.setTimeout(60000)

  async function uploadSample(userId: string, projectId: string) {
    const attemptId = crypto.randomUUID()
    const { error } = await admin.storage
      .from('artifacts')
      .upload(`${musicDir(userId, projectId)}/${attemptId}.mp3`, sampleAudio(), { contentType: 'audio/mpeg' })
    expect(error).toBeNull()
    return attemptId
  }

  test('an upload is free and its duration is read server-side from the stored file', async () => {
    const projectId = await seedProject(primary.user.id)
    await seedShots(projectId, [10])
    const attemptId = await uploadSample(primary.user.id, projectId)
    const result = await runMusicUploadRequest({ supabase: admin, projectId, userId: primary.user.id, attemptId, ext: 'mp3' })
    expect(result).toMatchObject({ ok: true })
    if (!result.ok) throw new Error('upload failed')
    expect(result.durationSec).toBeCloseTo(SAMPLE_SECONDS, 3)
    const music = await projectMusic(projectId)
    expect(music).toMatchObject({ music_source: 'uploaded', music_path: `${musicDir(primary.user.id, projectId)}/${attemptId}.mp3` })
    const after = await rows(projectId)
    expect(after.gens).toHaveLength(0)
    expect(after.usage).toHaveLength(0)
    expect(after.ledger).toHaveLength(0)
    expect(MUSIC_UPLOAD_MAX_SEC).toBeGreaterThan(SAMPLE_SECONDS)
  })

  test('an upload that is not audio is refused and nothing is linked', async () => {
    const projectId = await seedProject(primary.user.id)
    const attemptId = crypto.randomUUID()
    await admin.storage
      .from('artifacts')
      .upload(`${musicDir(primary.user.id, projectId)}/${attemptId}.mp3`, Buffer.from('not audio at all'), { contentType: 'audio/mpeg' })
    const result = await runMusicUploadRequest({ supabase: admin, projectId, userId: primary.user.id, attemptId, ext: 'mp3' })
    expect(result).toMatchObject({ ok: false, status: 422 })
    expect((await projectMusic(projectId)).music_path).toBeNull()
  })

  test('loop and mute save free and diff first; remove nulls the columns and keeps the file', async () => {
    const projectId = await seedProject(primary.user.id)
    await seedShots(projectId, [10])
    const attemptId = await uploadSample(primary.user.id, projectId)
    await runMusicUploadRequest({ supabase: admin, projectId, userId: primary.user.id, attemptId, ext: 'mp3' })

    expect(await setMusicLoopForUser(admin, primary.user.id, projectId, true)).toEqual({ success: true })
    expect(await setMusicLoopForUser(admin, primary.user.id, projectId, true)).toEqual({ success: true, unchanged: true })
    expect(await setMusicMutedForUser(admin, primary.user.id, projectId, true)).toEqual({ success: true })
    expect(await projectMusic(projectId)).toMatchObject({ music_loop: true, music_muted: true })

    const before = await listMusicFiles(primary.user.id, projectId)
    expect(await removeMusicForUser(admin, primary.user.id, projectId)).toEqual({ success: true })
    const music = await projectMusic(projectId)
    expect(music).toMatchObject({
      music_path: null,
      music_duration_sec: null,
      music_source: null,
      music_generated_at: null,
      music_loop: false,
      music_style_prompt: 'Soft piano, hopeful, slow',
    })
    expect(await listMusicFiles(primary.user.id, projectId)).toEqual(before)
    expect(before).toContain(`${attemptId}.mp3`)
    expect((await rows(projectId)).ledger).toHaveLength(0)
  })
})
