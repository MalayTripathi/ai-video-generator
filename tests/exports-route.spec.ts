import { test, expect } from '@playwright/test'
import { admin } from './supabase-test-session'
import { primary, secondary } from './fixed-users'
import { stepIndex } from '../src/lib/config/pipeline'

// The export routes against real rows, as the primary fixed user: one active export per
// project (a second request is 409), cancel only while queued, retry makes a new row with
// the same settings snapshot, and the page's lock enforced server-side. Export is free - no
// balance is read or charged. Scoped to this spec's own projects; no queued row is left
// behind for a running worker to pick up.

const KEY_CHARS = '23456789bcdfghjkmnpqrstvwxz'
const shotKey = () => Array.from({ length: 5 }, () => KEY_CHARS[Math.floor(Math.random() * KEY_CHARS.length)]).join('')

// First hits compile each route on the dev server, which is slow under a full parallel run.
test.setTimeout(90000)

const created: string[] = []

async function seed(opts: { missingImage?: boolean; settings?: Record<string, string> } = {}) {
  const { data: project, error } = await admin
    .from('projects')
    .insert({
      user_id: primary.user.id,
      title: 'Export route',
      source_text: 'A short film.',
      aspect_ratio: '9:16',
      current_step: 'storyboard',
      furthest_step: stepIndex('storyboard'),
      ...opts.settings,
    })
    .select('id')
    .single()
  expect(error).toBeNull()
  const projectId = project!.id
  created.push(projectId)
  const { error: shotError } = await admin.from('shots').insert(
    [0, 1].map((i) => ({
      project_id: projectId,
      order_index: i,
      shot_key: shotKey(),
      voice_over: `Line ${i + 1}.`,
      duration_sec: 2,
      image_path: opts.missingImage && i === 1 ? null : `${primary.user.id}/${projectId}/images/fake-${i}.webp`,
    }))
  )
  expect(shotError).toBeNull()
  return projectId
}

async function rows(projectId: string) {
  const { data } = await admin.from('exports').select('*').eq('project_id', projectId).order('created_at')
  return data ?? []
}

test.afterAll(async () => {
  if (created.length === 0) return
  await admin.from('exports').update({ status: 'cancelled' }).in('project_id', created).in('status', ['queued', 'rendering'])
})

test('a second export while one is active is refused with 409', async ({ request }) => {
  const projectId = await seed({ settings: { export_transition: 'cut', loudness_preset: 'podcast' } })
  const first = await request.post(`/api/projects/${projectId}/exports`)
  expect(first.status()).toBe(201)
  const second = await request.post(`/api/projects/${projectId}/exports`)
  expect(second.status()).toBe(409)
  const list = await rows(projectId)
  expect(list).toHaveLength(1)
  expect(list[0].status).toBe('queued')
  expect(list[0].user_id).toBe(primary.user.id)
  expect(list[0].settings).toMatchObject({ transition: 'cut', loudness: 'podcast', captions: 'off', motion: 'alternate' })
  expect(list[0].film_hash).toBeTruthy()

  // The history lists it, with its queue position.
  const history = await request.get(`/api/projects/${projectId}/exports`)
  expect(history.status()).toBe(200)
  const body = await history.json()
  expect(body.rows[0]).toMatchObject({ id: list[0].id, status: 'queued' })
  expect(body.rows[0].queuePosition).toBeGreaterThanOrEqual(1)
})

test('cancel is allowed only while queued', async ({ request }) => {
  const projectId = await seed()
  const res = await request.post(`/api/projects/${projectId}/exports`)
  const { data } = await res.json()

  // Once a worker has claimed it, cancel is refused and the row is untouched.
  await admin.from('exports').update({ status: 'rendering', started_at: new Date().toISOString() }).eq('id', data.id)
  const refused = await request.post(`/api/projects/${projectId}/exports/${data.id}/cancel`)
  expect(refused.status()).toBe(409)
  expect((await rows(projectId))[0].status).toBe('rendering')

  await admin.from('exports').update({ status: 'queued', started_at: null }).eq('id', data.id)
  const ok = await request.post(`/api/projects/${projectId}/exports/${data.id}/cancel`)
  expect(ok.status()).toBe(200)
  const [row] = await rows(projectId)
  expect(row.status).toBe('cancelled')
  expect(row.finished_at).not.toBeNull()

  // With nothing active, a new export can be queued again.
  expect((await request.post(`/api/projects/${projectId}/exports`)).status()).toBe(201)
})

test('retry on a failed export creates a new row with the same settings snapshot', async ({ request }) => {
  const projectId = await seed({ settings: { caption_mode: 'srt', export_motion: 'static' } })
  const res = await request.post(`/api/projects/${projectId}/exports`)
  const { data } = await res.json()

  // Retry is for failed exports only.
  expect((await request.post(`/api/projects/${projectId}/exports/${data.id}/retry`)).status()).toBe(409)

  await admin.from('exports').update({ status: 'failed', error: 'The render failed.' }).eq('id', data.id)
  // A settings change after the failure does not change what the retry renders with.
  await admin.from('projects').update({ export_motion: 'pan_up' }).eq('id', projectId)
  const retried = await request.post(`/api/projects/${projectId}/exports/${data.id}/retry`)
  expect(retried.status()).toBe(201)
  const { data: next } = await retried.json()
  expect(next.id).not.toBe(data.id)

  const list = await rows(projectId)
  expect(list).toHaveLength(2)
  const original = list.find((r) => r.id === data.id)!
  const copy = list.find((r) => r.id === next.id)!
  expect(original.status).toBe('failed')
  expect(copy.status).toBe('queued')
  expect(copy.settings).toEqual(original.settings)
  expect(copy.settings).toMatchObject({ motion: 'static' })
})

test('export is refused until every in-film frame has an image', async ({ request }) => {
  const projectId = await seed({ missingImage: true })
  const res = await request.post(`/api/projects/${projectId}/exports`)
  expect(res.status()).toBe(409)
  expect(await rows(projectId)).toHaveLength(0)
})

test('another user’s project is not found', async ({ request }) => {
  const { data: other, error } = await admin
    .from('projects')
    .insert({ user_id: secondary.user.id, title: 'Not yours', current_step: 'storyboard', furthest_step: stepIndex('storyboard') })
    .select('id')
    .single()
  expect(error).toBeNull()
  expect((await request.post(`/api/projects/${other!.id}/exports`)).status()).toBe(404)
  expect((await request.get(`/api/projects/${other!.id}/exports`)).status()).toBe(404)
  expect(await rows(other!.id)).toHaveLength(0)
})
