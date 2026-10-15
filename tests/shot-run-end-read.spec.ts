import { test, expect } from '@playwright/test'
import { admin } from './supabase-test-session'
import { primary } from './fixed-users'
import { stepIndex } from '../src/lib/config/pipeline'
import { parseRailFigures } from '../src/components/rail-figures-context'

// Layer: api. The reads behind a shot run's no-reload refresh, through the real routes: a
// status check carries the title the outline set, and the end-of-run read carries the title,
// the Assets elements and their generate gate, the rail's figures, and only the messages the
// run wrote - never an agent turn's (those carry a client id and are already in the panel),
// never one from before the run.

test('a status check carries the title; the end-of-run read carries title, elements, rail figures and only the run’s own messages', async ({ request }) => {
  const { data, error } = await admin
    .from('projects')
    .insert({
      user_id: primary.user.id,
      title: 'Harbour Lights',
      source_text: 'A harbour at night.',
      aspect_ratio: '9:16',
      video_model: 'wan-3.0',
      duration_target: '30-60s',
      current_step: 'workbench',
      furthest_step: stepIndex('workbench'),
    })
    .select('id')
    .single()
  expect(error).toBeNull()
  const projectId = data!.id
  const runStart = Date.now() - 60_000
  const at = (offsetMs: number) => new Date(runStart + offsetMs).toISOString()

  const writes = await Promise.all([
    admin.from('shot_runs').insert({
      project_id: projectId,
      attempt_id: crypto.randomUUID(),
      kind: 'generate',
      status: 'completed',
      total_scenes: 1,
      heartbeat_at: at(5_000),
      finished_at: at(5_000),
      charged_at: at(5_000),
      created_at: at(0),
      updated_at: at(5_000),
    }),
    admin.from('elements').insert([
      { project_id: projectId, name: 'The Harbour', type: 'location' },
      { project_id: projectId, name: 'The Ferryman', type: 'character' },
    ]),
    admin.from('messages').insert([
      // Before the run: never part of it.
      { project_id: projectId, role: 'assistant', content: 'An older note.', created_at: at(-30_000) },
      // An agent turn's reply during the run: already in the panel.
      { project_id: projectId, role: 'assistant', content: 'Rewriting now.', client_id: crypto.randomUUID(), created_at: at(1_000) },
      // The outline's message: the run's own.
      { project_id: projectId, role: 'assistant', content: 'One scene at the quay.', created_at: at(2_000) },
    ]),
  ])
  for (const w of writes) expect(w.error).toBeNull()

  const status = await request.get(`/api/projects/${projectId}/shots/status`)
  expect(status.status()).toBe(200)
  expect((await status.json()).title).toBe('Harbour Lights')

  const list = await request.get(`/api/projects/${projectId}/shots/list`)
  expect(list.status()).toBe(200)
  const body = await list.json()
  expect(body.title).toBe('Harbour Lights')
  expect(parseRailFigures(body.rail)).not.toBeNull()
  expect(body.elements.groups.reduce((n: number, g: { count: number }) => n + g.count, 0)).toBe(2)
  expect(typeof body.elements.expiresAt).toBe('string')
  expect(body.elements.generateCredits).toBeGreaterThan(0)
  expect(typeof body.elements.hasInsufficientBalance).toBe('boolean')
  expect(body.runMessages.map((m: { content: string }) => m.content)).toEqual(['One scene at the quay.'])
})
