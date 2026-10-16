import { test, expect } from '@playwright/test'
import { admin } from './supabase-test-session'
import { primary } from './fixed-users'
import { stepIndex } from '../src/lib/config/pipeline'
import { parseRailFigures } from '../src/components/rail-figures-context'

// Layer: api. The reads behind a shot run's no-reload refresh, through the real routes: a
// status check carries the title the outline set, and the end-of-run read carries the title,
// the Assets elements and their generate gate, the rail's figures, and only the run's plan
// note - never an agent turn's messages (its reply, activity or mid-turn text: already in the
// panel), never a note from before the run. An agent run's read also carries its turn's
// settled cost line: credits net of the hold's refund, and every call's dollars.

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
    // One uniform batch (every column on every row - CLAUDE.md's batch-insert rule).
    admin.from('messages').insert(
      [
        // Before the run: never part of it.
        { kind: 'run_note', client_id: null, tool_name: null, content: 'An older note.', created_at: at(-30_000) },
        // An agent turn's reply, activity and mid-turn text during the run: already in the panel.
        { kind: 'text', client_id: crypto.randomUUID(), tool_name: null, content: 'Rewriting now.', created_at: at(1_000) },
        { kind: 'tool_done', client_id: null, tool_name: 'get_shot', content: 'Looked at Shot 1', created_at: at(1_200) },
        { kind: 'text', client_id: null, tool_name: null, content: 'Let me check that shot.', created_at: at(1_400) },
        // The outline's note: the run's own.
        { kind: 'run_note', client_id: null, tool_name: null, content: 'One scene at the quay.', created_at: at(2_000) },
      ].map((m) => ({ project_id: projectId, role: 'assistant', ...m }))
    ),
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
  expect(body.turn).toBeNull() // a button run has no turn
})

test('an agent run’s end-of-run read carries its turn’s settled line: net credits and every call’s dollars - only once it is charged', async ({ request }) => {
  const { data, error } = await admin
    .from('projects')
    .insert({
      user_id: primary.user.id,
      title: 'Turn line',
      source_text: 'x',
      video_model: 'wan-3.0',
      duration_target: '30-60s',
      current_step: 'workbench',
      furthest_step: stepIndex('workbench'),
    })
    .select('id')
    .single()
  expect(error).toBeNull()
  const projectId = data!.id
  const attemptId = crypto.randomUUID()
  const { data: userMsg } = await admin
    .from('messages')
    .insert({ project_id: projectId, role: 'user', content: 'Regenerate all', client_id: crypto.randomUUID() })
    .select('id')
    .single()
  const { data: agentClaim } = await admin
    .from('generations')
    .insert({ project_id: projectId, step: 'workbench', operation: 'agent_turn', shot_id: null, element_id: null, state: 'generating' })
    .select('id')
    .single()
  const now = new Date().toISOString()
  const { data: run, error: runError } = await admin
    .from('shot_runs')
    .insert({
      project_id: projectId,
      attempt_id: attemptId,
      kind: 'generate',
      status: 'completed',
      total_scenes: 1,
      message_id: userMsg!.id,
      agent_generation_id: agentClaim!.id,
      heartbeat_at: now,
      finished_at: now,
      charged_at: null,
      created_at: now,
      updated_at: now,
    })
    .select('id')
    .single()
  expect(runError).toBeNull()
  const ledgerRow = (kind: 'spend' | 'refund', delta: number, dedupe: string, refunds: string | null) => ({
    user_id: primary.user.id,
    kind,
    delta,
    step: 'workbench',
    operation: 'agent_turn',
    project_id: projectId,
    message_id: userMsg!.id,
    shot_key: null,
    attempt_id: attemptId,
    dedupe_key: dedupe,
    hold_slot: kind === 'spend' ? 1_000_000 + Math.floor(Math.random() * 1_000_000_000) : null,
    price_version: 'test',
    pricing_mode: kind === 'spend' ? 'dynamic' : null,
    refunds_ledger_id: refunds,
  })
  const { data: hold, error: holdError } = await admin.from('credit_ledger').insert(ledgerRow('spend', -72, `hold:${attemptId}`, null)).select('id').single()
  expect(holdError).toBeNull()
  const usage = (cost: number) => ({
    user_id: primary.user.id,
    project_id: projectId,
    message_id: userMsg!.id,
    step: 'workbench',
    operation: 'generate_shots',
    provider: 'anthropic',
    model: 'claude-haiku-5-5',
    status: 'succeeded',
    estimated_cost: cost,
  })
  expect((await admin.from('usage').insert([usage(0.01), usage(0.0234)])).error).toBeNull()

  // Ended but not yet charged: no turn line - the hold alone is never shown as the charge.
  const early = await (await request.get(`/api/projects/${projectId}/shots/list`)).json()
  expect(early.turn).toBeNull()

  expect((await admin.from('credit_ledger').insert(ledgerRow('refund', 59, `settle:${hold!.id}`, hold!.id))).error).toBeNull()
  expect((await admin.from('shot_runs').update({ charged_at: new Date().toISOString() }).eq('id', run!.id)).error).toBeNull()
  const body = await (await request.get(`/api/projects/${projectId}/shots/list`)).json()
  expect(body.turn).toEqual({ messageId: userMsg!.id, credits: 13, usd: expect.closeTo(0.0334, 10) })
})
