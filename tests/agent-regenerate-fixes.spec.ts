import { test, expect } from '@playwright/test'
import type Anthropic from '@anthropic-ai/sdk'
import { admin, createFreshUser, releaseTestUser } from './supabase-test-session'
import { realRecordDynamicSpend } from './helpers/ledger-child'
import { scriptedGateway, successMessage, textMessage } from './helpers/claude-fakes'
import {
  REAL_SHOT_LEDGER,
  chainGateway,
  ensureTestCredits,
  fakeOutline,
  fakeShot,
  insertChainProject,
  readChainShots,
  runChain,
} from './helpers/shot-chain'
import { runAgentTurn } from '../src/app/api/projects/[id]/agent/logic'
import { getAgentStepConfig } from '../src/app/api/projects/[id]/agent/steps'
import { SHOT_LIST_REWRITING_MESSAGE } from '../src/app/api/projects/[id]/agent/tools'
import { deleteUnprotectedElements, isRemovableElement, removeUnusedElements, type CleanupCandidate } from '../src/lib/elements/cleanup'
import { bindElementToShotForUser } from '../src/app/(app)/projects/[id]/workbench/actions'
import { buildAgentMessages, linkRunNotes } from '../src/lib/build-agent-messages'
import { applyRunEnd, turnCostLineId } from '../src/lib/agent-run-end'
import type { AgentMessage } from '../src/components/workbench/agent-message'
import { formatCost } from '../src/lib/format-cost'

// Layer: api. The agent regenerate-all fixes: a run's recorded cost is the sum of its calls'
// with rewrites settling in parallel (F1); shot-changing tools refuse for the rest of a turn
// that started regenerate-all (D1); one style per project, the original kept (D2); the outline
// is given the existing element names, and the end-of-run cleanup removes only unused
// model-made elements - never a protected one (D3); and a plan note renders directly after the
// turn that started its run, on page load and at the run's end (F3).

const words = (tag: string, n: number) => Array.from({ length: n }, (_, i) => (i === 0 ? tag : `w${i}`)).join(' ')

let owner: { id: string }
test.beforeEach(async () => {
  owner = await createFreshUser()
})
test.afterEach(async () => {
  await releaseTestUser(owner.id)
})

async function liveElements(projectId: string) {
  const { data, error } = await admin
    .from('elements')
    .select('id, name, type, origin, user_edited_at, reference_image_path, created_at')
    .eq('project_id', projectId)
    .is('deleted_at', null)
  expect(error).toBeNull()
  return data ?? []
}

test.describe('F1 - parallel cost totals', () => {
  test('with many parallel chunks and rewrites settling in a mixed order, the run records exactly the sum of its calls - repeated', async () => {
    test.setTimeout(240_000)
    for (let round = 0; round < 3; round++) {
      // Six scenes, three at a time; every shot runs past its slot's cap, so every chunk
      // fires one rewrite per shot, all in parallel, each settling after a random delay.
      const projectId = await insertChainProject(owner.id, { duration_target: '1-2min' })
      const gateway = chainGateway({
        outline: fakeOutline(Array.from({ length: 6 }, (_, i) => ({ title: `S${i}`, seconds: 15, shot_count: 3 }))),
        usage: { input_tokens: 1234, output_tokens: 567 },
        rewriteDelayMs: () => Math.floor(Math.random() * 60),
        chunk: (ask) => ({
          shots: Array.from({ length: ask.maxShots }, (_, i) => fakeShot(words(`s${ask.scenePosition}i${i}`, 40))),
          scene_complete: true,
        }),
      })
      const { request } = await runChain({ projectId, userId: owner.id, gateway, concurrency: 3 })
      expect(request.ok).toBe(true)
      const runId = (request as { runId: string }).runId
      expect(gateway.calls.filter((c) => c.tool === 'rewrite_shot').length).toBeGreaterThan(6)

      const [{ data: run }, { data: usage }] = await Promise.all([
        admin.from('shot_runs').select('outline_cost_usd, shot_run_chunks(cost_usd)').eq('id', runId).single(),
        admin.from('usage').select('estimated_cost, status').eq('project_id', projectId),
      ])
      expect((usage ?? []).every((u) => u.status === 'succeeded')).toBe(true)
      expect(usage!.length).toBe(gateway.calls.length)
      const costs = (usage ?? []).map((u) => Number(u.estimated_cost))
      const calls = costs.reduce((sum, c) => sum + c, 0)
      const recorded =
        Number(run!.outline_cost_usd) + (run!.shot_run_chunks as { cost_usd: number }[]).reduce((sum, c) => sum + Number(c.cost_usd), 0)
      expect(calls).toBeGreaterThan(0)
      // usage.estimated_cost is stored to 6 decimals, the run's figures unrounded: equal up to
      // that rounding, which is far below one call's cost - a lost call would show.
      const rounding = costs.length * 5e-7
      expect(rounding).toBeLessThan(Math.min(...costs) / 2)
      expect(Math.abs(recorded - calls)).toBeLessThanOrEqual(rounding)
    }
  })
})

test.describe('D1 - shot tools after regenerate-all in the same turn', () => {
  test('edit, insert and a second regenerate are refused with the reason; the shots are unchanged; looking at a shot still works', async () => {
    test.setTimeout(120_000)
    const projectId = await insertChainProject(owner.id, { duration_target: '30-60s' })
    await ensureTestCredits(owner.id)
    const seeded = await admin
      .from('shots')
      .insert([0, 1].map((i) => ({ project_id: projectId, order_index: i, shot_key: `tst${i + 2}x`, voice_over: `Original ${i}`, visual_description: `Visual ${i}` })))
      .select('id')
    expect(seeded.error).toBeNull()

    const usage = { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
    const multi = {
      message: {
        content: [
          { type: 'tool_use', id: 'tu_update', name: 'update_shot', input: { shot_number: 1, voice_over: 'Changed' } },
          { type: 'tool_use', id: 'tu_insert', name: 'insert_shot', input: { position: 'end', voice_over: 'New', visual_description: 'New shot' } },
          { type: 'tool_use', id: 'tu_regen', name: 'regenerate_all_shots', input: {} },
        ],
        usage,
      } as unknown as Anthropic.Message,
      stopReason: 'tool_use',
      requestId: 'req_test',
    }
    const gateway = scriptedGateway([
      successMessage({}, 'regenerate_all_shots', usage),
      multi,
      successMessage({ shot_number: 1 }, 'get_shot', usage),
      textMessage('The shot list is being rewritten - ask again once it finishes.', usage),
    ])
    const started: string[] = []
    const turn = await runAgentTurn({
      config: getAgentStepConfig('workbench'),
      gateway,
      supabase: admin,
      projectId,
      userId: owner.id,
      content: 'Regenerate everything, then shorten shot 1',
      clientId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      recordTurnSpend: realRecordDynamicSpend,
      getBalance: async () => 1_000_000,
      ensureSignupGrant: async () => {},
      shotRuns: {
        ledger: REAL_SHOT_LEDGER,
        start: async (run) => {
          started.push(run.runId)
          return true
        },
      },
    })
    expect(turn.ok).toBe(true)
    expect(started).toHaveLength(1) // the second regenerate never started a run

    // What the model was told for each refused call, and for the read: every tool result the
    // last call carried, by tool_use id.
    const results = new Map(
      gateway
        .getCalls()[3]
        .messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []))
        .filter((b): b is Anthropic.ToolResultBlockParam => b.type === 'tool_result')
        .map((b) => [b.tool_use_id, { isError: b.is_error, content: String(b.content) }])
    )
    for (const id of ['tu_update', 'tu_insert', 'tu_regen']) {
      expect(results.get(id)?.isError).toBe(true)
      expect(results.get(id)?.content).toContain(SHOT_LIST_REWRITING_MESSAGE)
    }
    const reads = [...results.values()].filter((r) => !r.isError)
    expect(reads.some((r) => r.content.includes('Original 0'))).toBe(true)

    const shots = await readChainShots(projectId)
    expect(shots.map((s) => s.voice_over)).toEqual(['Original 0', 'Original 1'])
    const { data: refusals } = await admin.from('messages').select('content').eq('project_id', projectId).eq('kind', 'refusal')
    expect(refusals).toHaveLength(3)
    const { data: reply } = await admin
      .from('messages')
      .select('content')
      .eq('project_id', projectId)
      .eq('role', 'assistant')
      .eq('kind', 'text')
      .not('client_id', 'is', null)
      .single()
    expect(reply!.content).toContain('ask again once it finishes')
  })
})

test.describe('D2 - one style per project', () => {
  test('regenerating twice keeps exactly one style, the original', async () => {
    test.setTimeout(120_000)
    const projectId = await insertChainProject(owner.id, { duration_target: '30-60s' })
    const run = (styleName: string, retry: boolean) =>
      runChain({
        projectId,
        userId: owner.id,
        retry,
        gateway: chainGateway({
          outline: fakeOutline([{ title: 'A', seconds: 20 }], { style: [{ name: styleName, description: 'keywords' }] }),
          chunk: () => ({ shots: [fakeShot('One two three four')], scene_complete: true }),
        }),
      })
    await run('Ink Wash', false)
    await run('Oil Paint', true)
    const styles = (await liveElements(projectId)).filter((e) => e.type === 'style')
    expect(styles.map((s) => s.name)).toEqual(['Ink Wash'])
  })

  test('the database refuses a second live style', async () => {
    const projectId = await insertChainProject(owner.id)
    const first = await admin.from('elements').insert({ project_id: projectId, name: 'Style one', type: 'style' })
    expect(first.error).toBeNull()
    const second = await admin.from('elements').insert({ project_id: projectId, name: 'Style two', type: 'style' })
    expect(second.error?.code).toBe('23505')
  })
})

test.describe('D3 - elements on a plan made from scratch', () => {
  test('the outline is given the existing names; unused model-made elements go; protected ones, the style and an unwritten scene’s cast stay', async () => {
    test.setTimeout(120_000)
    const projectId = await insertChainProject(owner.id, { duration_target: '30-60s' })
    const cast = (name: string, type = 'character') => ({ name, type, description: `${name} desc` })
    // First plan: five elements bound to shots, plus the style.
    await runChain({
      projectId,
      userId: owner.id,
      gateway: chainGateway({
        outline: fakeOutline([{ title: 'A', seconds: 20 }], { style: [{ name: 'Ink Wash', description: 'k' }] }),
        chunk: () => ({
          shots: [
            fakeShot('One two three four', {
              element_names: [cast('Kaikeyi'), cast('Old Palace', 'location'), cast('Edited Hero'), cast('Imaged Horse'), cast('Gone Prop', 'prop'), cast('Lantern', 'prop')],
            }),
          ],
          scene_complete: true,
        }),
      }),
    })
    const before = await liveElements(projectId)
    const id = (name: string) => before.find((e) => e.name === name)!.id
    // A person renamed one; another has a reference image; a person made a third.
    expect((await admin.from('elements').update({ user_edited_at: new Date().toISOString() }).eq('id', id('Edited Hero'))).error).toBeNull()
    expect((await admin.from('elements').update({ reference_image_path: 'x/ref.png', status: 'ready' }).eq('id', id('Imaged Horse'))).error).toBeNull()
    expect((await admin.from('elements').insert({ project_id: projectId, name: 'My Own Prop', type: 'prop', origin: 'user' })).error).toBeNull()

    // Second plan: reuses Kaikeyi, and names Lantern for scene C, which it never writes.
    let outlineBlock = ''
    await runChain({
      projectId,
      userId: owner.id,
      retry: true,
      gateway: chainGateway({
        outline: fakeOutline(
          [
            { title: 'B', seconds: 20, element_names: ['Kaikeyi'] },
            { title: 'C', seconds: 20, element_names: ['Lantern'] },
          ],
          { style: [{ name: 'Oil Paint', description: 'k' }] }
        ),
        onRequest: (p) => {
          if ((p.tool_choice as { name?: string }).name === 'write_outline') {
            outlineBlock = (p.system as { text: string }[]).map((b) => b.text).join('\n')
          }
        },
        chunk: (ask) =>
          ask.scenePosition === 0
            ? { shots: [fakeShot('Five six seven eight', { element_names: [cast('Kaikeyi')] })], scene_complete: true }
            : { shots: [], scene_complete: false },
      }),
    })
    for (const name of ['Kaikeyi (character)', 'Lantern (prop)', 'Old Palace (location)', 'Edited Hero (character)', 'Imaged Horse (character)', 'Gone Prop (prop)', 'My Own Prop (prop)']) {
      expect(outlineBlock).toContain(`- ${name}`)
    }
    expect(outlineBlock).not.toContain('Ink Wash')

    const after = await liveElements(projectId)
    // Lantern is unused but named for scene C, which was never written: kept.
    expect(after.map((e) => e.name).sort()).toEqual(['Edited Hero', 'Imaged Horse', 'Ink Wash', 'Kaikeyi', 'Lantern', 'My Own Prop'].sort())
    expect(after.find((e) => e.name === 'Kaikeyi')!.id).toBe(id('Kaikeyi')) // reused, never duplicated
    // Removed elements are deleted outright - the rows are gone, none left soft-deleted.
    const { data: all } = await admin.from('elements').select('id, deleted_at').eq('project_id', projectId)
    expect((all ?? []).every((e) => e.deleted_at === null)).toBe(true)
    expect((all ?? []).map((e) => e.id)).not.toContain(id('Gone Prop'))
    expect((all ?? []).map((e) => e.id)).not.toContain(id('Old Palace'))
  })

  test('an approved cleanup never removes a protected element - each protection alone, and an unwritten scene’s name', async () => {
    const projectId = await insertChainProject(owner.id)
    const now = new Date().toISOString()
    const rows = [
      { name: 'Plain', type: 'prop' },
      { name: 'Styled', type: 'style' },
      { name: 'Users', type: 'prop', origin: 'user' },
      { name: 'Edited', type: 'prop', user_edited_at: now },
      { name: 'Imaged', type: 'prop', reference_image_path: 'p/ref.png', status: 'ready' },
      { name: 'Generating', type: 'prop', status: 'generating' },
      { name: 'Unwritten Cast', type: 'character' },
    ].map((r) => ({ project_id: projectId, origin: 'model', user_edited_at: null, reference_image_path: null, status: 'pending', ...r }))
    expect((await admin.from('elements').insert(rows)).error).toBeNull()
    const removed = await removeUnusedElements(admin, projectId, owner.id, ['unwritten cast'])
    const { data: all } = await admin.from('elements').select('name').eq('project_id', projectId)
    expect(removed).toHaveLength(1)
    expect((all ?? []).map((e) => e.name).sort()).toEqual(['Edited', 'Generating', 'Imaged', 'Styled', 'Unwritten Cast', 'Users'])

    // The rule itself, over every protection.
    const base: CleanupCandidate = {
      id: 'x', name: 'X', type: 'prop', origin: 'model', user_edited_at: null, reference_image_path: null, status: 'pending',
      shot_elements: [{ count: 0 }], shot_dialogue: [{ count: 0 }],
    }
    expect(isRemovableElement(base, new Set())).toBe(true)
    for (const patch of [
      { type: 'style' },
      { origin: 'user' },
      { user_edited_at: now },
      { reference_image_path: 'r.png' },
      { status: 'generating' },
      { shot_elements: [{ count: 1 }] },
      { shot_dialogue: [{ count: 1 }] },
    ] as Partial<CleanupCandidate>[]) {
      expect(isRemovableElement({ ...base, ...patch }, new Set())).toBe(false)
    }
    expect(isRemovableElement(base, new Set(['x']))).toBe(false)
  })

  test('an attach that lands between the cleanup’s read and its delete keeps the element and its link', async () => {
    const projectId = await insertChainProject(owner.id)
    const { data: shot } = await admin
      .from('shots')
      .insert({ project_id: projectId, order_index: 0, shot_key: 'tstzz', voice_over: 'A line.', visual_description: 'A visual.' })
      .select('id')
      .single()
    const { data: el } = await admin.from('elements').insert({ project_id: projectId, name: 'Late Attach', type: 'prop' }).select('id').single()
    // The cleanup read it unused; a person attaches it; then the delete runs on that id.
    const bound = await bindElementToShotForUser(admin, shot!.id, el!.id, owner.id, 'workbench')
    expect(bound.success).toBe(true)
    expect(await deleteUnprotectedElements(admin, projectId, owner.id, [el!.id])).toEqual([])
    const [{ data: still }, { data: link }] = await Promise.all([
      admin.from('elements').select('id, user_edited_at').eq('id', el!.id).maybeSingle(),
      admin.from('shot_elements').select('element_id').eq('element_id', el!.id),
    ])
    expect(still?.user_edited_at).not.toBeNull()
    expect(link).toHaveLength(1)
  })

  test('cleanup deletes an unused element with old failed generations rows, and keeps one whose row holds paid output', async () => {
    const projectId = await insertChainProject(owner.id)
    const { data: els } = await admin
      .from('elements')
      .insert([
        { project_id: projectId, name: 'Old Failure', type: 'prop' },
        { project_id: projectId, name: 'Paid Output', type: 'prop' },
      ])
      .select('id, name')
    const id = (name: string) => els!.find((e) => e.name === name)!.id
    const gen = (elementId: string, payload: { path: string } | null) => ({
      project_id: projectId,
      step: 'workbench',
      operation: 'generate_element_reference',
      shot_id: null,
      element_id: elementId,
      state: 'failed',
      payload,
    })
    const { error } = await admin
      .from('generations')
      .insert([gen(id('Old Failure'), null), gen(id('Paid Output'), { path: `${owner.id}/${projectId}/elements/x/paid.webp` })])
    expect(error).toBeNull()
    const warnings: string[] = []
    const warn = console.warn
    console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(' '))
    let removed: string[]
    try {
      removed = await removeUnusedElements(admin, projectId, owner.id, [])
    } finally {
      console.warn = warn
    }
    expect(removed).toEqual([id('Old Failure')])
    expect(warnings.some((w) => w.includes(id('Paid Output')))).toBe(true)
    const [{ data: left }, { data: gens }] = await Promise.all([
      admin.from('elements').select('id').eq('project_id', projectId),
      admin.from('generations').select('element_id').eq('project_id', projectId),
    ])
    expect((left ?? []).map((e) => e.id)).toEqual([id('Paid Output')])
    expect((gens ?? []).map((g) => g.element_id)).toEqual([id('Paid Output')])
  })

  test('a reference request at the moment of cleanup keeps the element, and the request still attaches', async () => {
    const projectId = await insertChainProject(owner.id)
    const { data: el } = await admin.from('elements').insert({ project_id: projectId, name: 'Racing Ref', type: 'prop' }).select('id').single()
    // The request's claim lands as cleanup runs (the element still reads pending/unreferenced).
    const { data: claim, error } = await admin
      .from('generations')
      .insert({
        project_id: projectId, step: 'workbench', operation: 'generate_element_reference', shot_id: null, element_id: el!.id,
        state: 'generating', started_at: new Date().toISOString(),
      })
      .select('id')
      .single()
    expect(error).toBeNull()
    expect(await removeUnusedElements(admin, projectId, owner.id, [])).toEqual([])
    // At the database too: a delete the claim now references is refused (23503), never cascaded.
    const direct = await admin.from('elements').delete().eq('id', el!.id)
    expect(direct.error?.code).toBe('23503')
    // The request completes and attaches to the element that survived.
    const path = `${owner.id}/${projectId}/elements/${el!.id}/ref.webp`
    expect((await admin.from('elements').update({ reference_image_path: path, status: 'ready' }).eq('id', el!.id)).error).toBeNull()
    expect((await admin.from('generations').update({ state: 'succeeded' }).eq('id', claim!.id)).error).toBeNull()
    const { data: after } = await admin.from('elements').select('reference_image_path, status').eq('id', el!.id).single()
    expect(after).toEqual({ reference_image_path: path, status: 'ready' })
  })
})

test.describe('F3 - plan note placement', () => {
  const t = (s: number) => new Date(Date.UTC(2026, 9, 16, 8, 0, s)).toISOString()
  const row = (id: string, s: number, extra: Partial<{ role: string; kind: string; client_id: string | null; tool_name: string | null; shot_key: string | null; content: string }>) => ({
    id,
    role: 'assistant',
    kind: 'text',
    client_id: null,
    tool_name: null,
    shot_key: null,
    content: id,
    created_at: t(s),
    ...extra,
  })
  const runs = [{ message_id: 'u1', agent_generation_id: 'g1', created_at: t(5) }]

  for (const [label, noteAt] of [
    ['written before the reply', 8],
    ['written after the reply', 30],
  ] as const) {
    test(`page load: an agent run's note ${label} renders directly after its turn's cost line`, () => {
      const rows = [
        row('u1', 0, { role: 'user', client_id: 'c1', content: 'Regenerate all' }),
        row('done', 6, { kind: 'tool_done', tool_name: 'regenerate_all_shots', content: 'Started rewriting all shots' }),
        row('reply', 20, { client_id: 'c1', content: 'On it.' }),
        row('note', noteAt, { kind: 'run_note', content: 'I have planned a short film.' }),
        row('u2', 40, { role: 'user', client_id: 'c2', content: 'Next' }),
        row('reply2', 41, { client_id: 'c2', content: 'Done.' }),
      ].sort((a, b) => a.created_at.localeCompare(b.created_at))
      const out = buildAgentMessages(rows, new Map(), new Map([['u1', 0.02]]), new Map([['u1', 13]]), linkRunNotes(rows, runs))
      expect(out.map((m) => m.id)).toEqual(['u1', 'done', 'reply', turnCostLineId('u1'), 'note', 'u2', 'reply2'])
    })

    test(`end-of-run refresh: a note ${label} lands directly after the turn's cost line, which takes the settled figures`, () => {
      const prev: AgentMessage[] = [
        { id: 'live-user', kind: 'user', content: 'Regenerate all', createdAt: t(0) },
        { id: 'live-done', kind: 'tool_done', content: 'Started rewriting all shots', createdAt: t(6) },
        { id: 'live-reply', kind: 'agent', content: 'On it.', createdAt: t(20) },
        { id: turnCostLineId('u1'), kind: 'cost', content: '', amount: '$0.01', creditAmount: '72 cr', createdAt: t(20) },
      ]
      const note: AgentMessage = { id: 'note', kind: 'agent', content: 'I have planned a short film.', createdAt: t(noteAt) }
      const turn = { messageId: 'u1', credits: 13, usd: 0.0321 }
      const once = applyRunEnd(prev, [note], turn)
      expect(once.map((m) => m.id)).toEqual(['live-user', 'live-done', 'live-reply', turnCostLineId('u1'), 'note'])
      expect(once[3]).toMatchObject({ creditAmount: '13 cr', amount: formatCost(0.0321) })
      // A second read of the same run changes nothing - no line is added twice.
      expect(applyRunEnd(once, [note], turn)).toEqual(once)
    })
  }

  test('a button run’s note renders in time order, and a note older than every run stays where it was written', () => {
    const rows = [
      row('old-note', 1, { kind: 'run_note', content: 'Older plan' }),
      row('u1', 10, { role: 'user', client_id: 'c1', content: 'Make shot 1 shorter' }),
      row('reply', 12, { client_id: 'c1', content: 'Done.' }),
      row('button-note', 20, { kind: 'run_note', content: 'Button plan' }),
    ]
    const buttonRuns = [{ message_id: null, agent_generation_id: null, created_at: t(15) }]
    const out = buildAgentMessages(rows, new Map(), new Map([['u1', 0.01]]), new Map(), linkRunNotes(rows, buttonRuns))
    expect(out.map((m) => m.id)).toEqual(['old-note', 'u1', 'reply', turnCostLineId('u1'), 'button-note'])
  })
})
