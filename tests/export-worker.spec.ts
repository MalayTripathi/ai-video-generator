import { test, expect } from '@playwright/test'
import { admin } from './supabase-test-session'
import { primary } from './fixed-users'
import { stepIndex } from '../src/lib/config/pipeline'
import { EXPORT_RETENTION, EXPORT_STUCK_TIMEOUT_MS } from '../src/lib/config/export'
import { claimExport, failStuck, STUCK_ERROR } from '../worker/claim'
import { applyRetention } from '../worker/retention'
import { ffmpegPath, FONTS_DIR, type WorkerDb } from '../worker/config'
import { probe, runFfmpeg } from '../worker/ffmpeg'
import { runJob, exportDir } from '../worker/job'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'

// The export worker's database side, against real rows through the service-role client
// (the worker's own credentials): the atomic claim, the stuck-job sweep, and retention.
// Every assertion is scoped to rows this spec created.

const db = admin as unknown as WorkerDb
const KEY_CHARS = '23456789bcdfghjkmnpqrstvwxz'
const shotKey = () => Array.from({ length: 5 }, () => KEY_CHARS[Math.floor(Math.random() * KEY_CHARS.length)]).join('')
const SETTINGS = {
  motion: 'alternate',
  transition: 'dissolve',
  captions: 'off',
  captionStyle: 'reelcraft_default',
  captionPosition: 'bottom',
  loudness: 'streaming',
  aspectRatio: '9:16',
}

async function project(): Promise<string> {
  const { data, error } = await admin
    .from('projects')
    .insert({
      user_id: primary.user.id,
      title: 'Export worker',
      current_step: 'storyboard',
      furthest_step: stepIndex('storyboard'),
    })
    .select('id')
    .single()
  expect(error).toBeNull()
  return data!.id
}

async function exportRow(projectId: string, fields: Record<string, unknown> = {}): Promise<string> {
  const { data, error } = await admin
    .from('exports')
    .insert({
      user_id: primary.user.id,
      project_id: projectId,
      status: 'queued',
      settings: SETTINGS,
      film_hash: 'h',
      progress: 0,
      ...fields,
    })
    .select('id')
    .single()
  expect(error).toBeNull()
  return data!.id
}

test('claiming is atomic: two workers racing for one export, exactly one wins', async () => {
  const projectId = await project()
  const id = await exportRow(projectId)
  const [a, b] = await Promise.all([claimExport(db, id), claimExport(db, id)])
  const winners = [a, b].filter((r) => r !== null)
  expect(winners).toHaveLength(1)
  expect(winners[0]!.id).toBe(id)
  expect(winners[0]!.status).toBe('rendering')
  expect(winners[0]!.started_at).not.toBeNull()
  // Claimed once, never again.
  expect(await claimExport(db, id)).toBeNull()
  const { data } = await admin.from('exports').select('status').eq('id', id).single()
  expect(data!.status).toBe('rendering')
  await admin.from('exports').update({ status: 'failed' }).eq('id', id)
})

test('a job rendering past the timeout is marked failed on the next poll; a recent one is not', async () => {
  const projectId = await project()
  const now = new Date()
  const stuck = await exportRow(projectId, {
    status: 'rendering',
    started_at: new Date(now.getTime() - EXPORT_STUCK_TIMEOUT_MS - 60_000).toISOString(),
  })
  const failed = await failStuck(db, now)
  expect(failed).toContain(stuck)
  const { data } = await admin.from('exports').select('status, error, finished_at').eq('id', stuck).single()
  expect(data!.status).toBe('failed')
  expect(data!.error).toBe(STUCK_ERROR)
  expect(data!.finished_at).not.toBeNull()

  // A second project: one active export per project, so the fresh one needs its own.
  const fresh = await exportRow(await project(), { status: 'rendering', started_at: now.toISOString() })
  expect(await failStuck(db, now)).not.toContain(fresh)
  await admin.from('exports').update({ status: 'failed' }).eq('id', fresh)
})

test('retention keeps the newest succeeded exports and deletes older rows and their files', async () => {
  const projectId = await project()
  const base = Date.now() - 60 * 60_000
  const ids: string[] = []
  for (let i = 0; i < EXPORT_RETENTION + 2; i++) {
    const mp4 = `${primary.user.id}/${projectId}/exports/retention-${i}/film.mp4`
    await admin.storage.from('artifacts').upload(mp4, Buffer.from(`clip ${i}`), { contentType: 'video/mp4', upsert: true })
    ids.push(
      await exportRow(projectId, {
        status: 'succeeded',
        progress: 100,
        mp4_path: mp4,
        finished_at: new Date(base + i * 60_000).toISOString(),
      })
    )
  }
  // A failed export is history, not an output - retention leaves it alone.
  const failedId = await exportRow(projectId, { status: 'failed', finished_at: new Date(base).toISOString() })

  const deleted = await applyRetention(db, projectId)
  expect(deleted.sort()).toEqual(ids.slice(0, 2).sort())
  const { data: left } = await admin.from('exports').select('id').eq('project_id', projectId)
  expect(left!.map((r) => r.id).sort()).toEqual([...ids.slice(2), failedId].sort())
  const { data: files } = await admin.storage.from('artifacts').list(`${primary.user.id}/${projectId}/exports`)
  const folders = (files ?? []).map((f) => f.name).sort()
  expect(folders).toEqual(Array.from({ length: EXPORT_RETENTION }, (_, i) => `retention-${i + 2}`).sort())
  await admin.storage
    .from('artifacts')
    .remove(folders.map((f) => `${primary.user.id}/${projectId}/exports/${f}/film.mp4`))
})

test('a claimed job renders the seeded film, uploads its outputs and settles succeeded', async () => {
  const bin = ffmpegPath()
  test.skip(!bin || !existsSync(bin), 'ffmpeg-static binary unavailable')
  test.setTimeout(120_000)
  const projectId = await project()
  const dir = await mkdtemp(path.join(os.tmpdir(), 'export-job-'))
  const uploaded: string[] = []
  try {
    // Two stills and a 3s tone as the voiceover, with a matching read on the project.
    const shotIds: string[] = []
    const { data: scenes } = await admin
      .from('scenes')
      .insert([
        { project_id: projectId, position: 0, title: 'Opening' },
        { project_id: projectId, position: 1, title: 'Close' },
      ])
      .select('id, position')
    for (const [i, colour] of ['#c0392b', '#2980b9'].entries()) {
      const { data: shot } = await admin
        .from('shots')
        .insert({ project_id: projectId, order_index: i, shot_key: shotKey(), voice_over: i === 0 ? 'Hello there' : 'friend', duration_sec: 2, scene_id: scenes!.find((s) => s.position === i)!.id })
        .select('id')
        .single()
      const imagePath = `${primary.user.id}/${projectId}/images/${shot!.id}/still.webp`
      const bytes = await sharp({ create: { width: 360, height: 640, channels: 3, background: colour } }).webp().toBuffer()
      await admin.storage.from('artifacts').upload(imagePath, bytes, { contentType: 'image/webp', upsert: true })
      uploaded.push(imagePath)
      await admin.from('shots').update({ image_path: imagePath }).eq('id', shot!.id)
      shotIds.push(shot!.id)
    }
    const tone = path.join(dir, 'voice.mp3')
    await runFfmpeg(bin!, ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:a', 'libmp3lame', tone])
    const audioPath = `${primary.user.id}/${projectId}/voiceover/job.mp3`
    await admin.storage.from('artifacts').upload(audioPath, await readFile(tone), { contentType: 'audio/mpeg', upsert: true })
    uploaded.push(audioPath)
    await admin
      .from('projects')
      .update({
        aspect_ratio: '9:16',
        audio_path: audioPath,
        voiceover_source: 'generated',
        voiceover_generated_at: new Date().toISOString(),
        total_duration_sec: 3,
        voiceover_spans: [
          { shotId: shotIds[0], from: 0, to: 11, text: 'Hello there', startSec: 0.1, endSec: 1.0 },
          { shotId: shotIds[1], from: 12, to: 18, text: 'friend', startSec: 2.3, endSec: 2.9 },
        ],
        voiceover_words: [[0.1, 0.5], [0.6, 1.0], [2.3, 2.9]],
      })
      .eq('id', projectId)

    const id = await exportRow(projectId, { settings: { ...SETTINGS, captions: 'srt' } })
    const claimed = await claimExport(db, id)
    expect(claimed).not.toBeNull()
    const result = await runJob(db, claimed!, { ffmpeg: bin!, fontsDir: existsSync(FONTS_DIR) ? FONTS_DIR : null, isProduction: false })
    expect(result).toBe('succeeded')

    const { data: row } = await admin.from('exports').select('*').eq('id', id).single()
    const folder = exportDir(primary.user.id, projectId, id)
    expect(row).toMatchObject({
      status: 'succeeded',
      progress: 100,
      mp4_path: `${folder}/film.mp4`,
      srt_path: `${folder}/captions.srt`,
      chapters_path: `${folder}/chapters.txt`,
      error: null,
    })
    expect(Number(row!.duration_sec)).toBeCloseTo(4, 1)
    expect(row!.size_bytes).toBeGreaterThan(0)
    uploaded.push(row!.mp4_path!, row!.srt_path!, row!.chapters_path!)

    const { data: mp4 } = await admin.storage.from('artifacts').download(row!.mp4_path!)
    const local = path.join(dir, 'out.mp4')
    await writeFile(local, Buffer.from(await mp4!.arrayBuffer()))
    const probed = await probe(bin!, local)
    expect([probed.width, probed.height, probed.hasAudio]).toEqual([360, 640, true])
    const { data: srt } = await admin.storage.from('artifacts').download(row!.srt_path!)
    expect(await srt!.text()).toContain('Hello there')
  } finally {
    await admin.storage.from('artifacts').remove(uploaded)
    await rm(dir, { recursive: true, force: true })
  }
})
