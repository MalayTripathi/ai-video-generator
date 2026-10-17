import { test, expect } from '@playwright/test'
import { admin } from './supabase-test-session'
import { primary } from './fixed-users'
import { discardFolderExcept, discardReplacedFiles, processPendingDeletions } from '../src/lib/storage/replaced'
import { listObjectsUnder } from '../src/lib/storage/sweep'
import { claimExport } from '../worker/claim'
import { runJob } from '../worker/job'
import type { WorkerDb } from '../worker/config'
import { deleteShotForUser } from '../src/app/(app)/projects/[id]/workbench/actions'

// Replaced files in a kept project (lib/storage/replaced.ts), against real rows and the real
// bucket: removed right after the commit; never while a generations payload holds the path;
// queued - never removed - while an export is queued or rendering, and removed when that
// export ends; a deleted shot's files go with it. Scoped to this spec's own projects.

const userId = primary.user.id
const KEY_CHARS = '23456789bcdfghjkmnpqrstvwxz'
const shotKey = () => Array.from({ length: 5 }, () => KEY_CHARS[Math.floor(Math.random() * KEY_CHARS.length)]).join('')

async function project(): Promise<string> {
  const { data, error } = await admin.from('projects').insert({ user_id: userId, title: 'Replaced files' }).select('id').single()
  expect(error).toBeNull()
  return data!.id
}

async function put(path: string) {
  const { error } = await admin.storage.from('artifacts').upload(path, Buffer.from('x'), { contentType: 'application/octet-stream' })
  expect(error).toBeNull()
}

const exists = async (path: string) => {
  const folder = path.slice(0, path.lastIndexOf('/'))
  return (await listObjectsUnder(admin, folder)).includes(path)
}

test('a replaced file is removed after the commit, but never one a payload holds or one outside the project', async () => {
  const projectId = await project()
  const replaced = `${userId}/${projectId}/music/old.mp3`
  const held = `${userId}/${projectId}/music/held.mp3`
  const current = `${userId}/${projectId}/music/new.mp3`
  const foreign = `${userId}/${crypto.randomUUID()}/music/x.mp3`
  for (const p of [replaced, held, current, foreign]) await put(p)
  expect(
    (
      await admin.from('generations').insert({
        project_id: projectId, step: 'storyboard', operation: 'background_music', shot_id: null, element_id: null, state: 'failed', payload: { kind: 'generate', path: held },
      })
    ).error
  ).toBeNull()

  await discardReplacedFiles({ userId, projectId, paths: [replaced, held, current, foreign, null], keep: [current] })

  expect(await exists(replaced)).toBe(false)
  expect(await exists(held)).toBe(true)
  expect(await exists(current)).toBe(true)
  expect(await exists(foreign)).toBe(true)
  await admin.storage.from('artifacts').remove([foreign])
})

test('while an export renders, a replaced file is queued and kept; the export ending removes it', async () => {
  const projectId = await project()
  const replaced = `${userId}/${projectId}/images/s1/old.webp`
  await put(replaced)
  const { data: exportRow, error } = await admin
    .from('exports')
    .insert({ user_id: userId, project_id: projectId, status: 'queued', settings: {}, film_hash: 'h', progress: 0 })
    .select('id')
    .single()
  expect(error).toBeNull()

  await discardFolderExcept({ userId, projectId, folder: `${userId}/${projectId}/images/s1`, keep: [] })
  expect(await exists(replaced)).toBe(true)
  const { data: pending } = await admin.from('pending_storage_deletions').select('path').eq('project_id', projectId)
  expect(pending).toEqual([{ path: replaced }])

  // Nothing is removed while the export is still active.
  expect(await processPendingDeletions(admin, projectId)).toBe(0)
  expect(await exists(replaced)).toBe(true)

  // The worker claims and runs it; these settings are unreadable, so it fails fast - and its
  // end, success or failure, removes what was queued behind it.
  const claimed = await claimExport(admin as unknown as WorkerDb, exportRow!.id)
  expect(claimed).not.toBeNull()
  const result = await runJob(admin as unknown as WorkerDb, claimed!, { ffmpeg: 'ffmpeg', fontsDir: null, isProduction: false })
  expect(result).toBe('failed')
  expect(await exists(replaced)).toBe(false)
  expect((await admin.from('pending_storage_deletions').select('id').eq('project_id', projectId)).data).toEqual([])
})

test('deleting a shot removes its image files', async () => {
  const projectId = await project()
  const { data: shot, error } = await admin
    .from('shots')
    .insert({ project_id: projectId, order_index: 0, shot_key: shotKey(), voice_over: 'A line.', visual_description: 'A visual.' })
    .select('id')
    .single()
  expect(error).toBeNull()
  const folder = `${userId}/${projectId}/images/${shot!.id}`
  await put(`${folder}/a.webp`)
  await put(`${folder}/a_thumb.webp`)

  const result = await deleteShotForUser(admin, shot!.id, userId)
  expect(result.success).toBe(true)
  expect(await listObjectsUnder(admin, folder)).toEqual([])
})
