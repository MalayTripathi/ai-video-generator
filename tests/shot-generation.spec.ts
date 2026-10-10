import { test, expect } from '@playwright/test'
import { admin } from './supabase-test-session'
import { primary } from './fixed-users'
import { successMessage, throwingGateway, truncatedMessage } from './helpers/claude-fakes'
import { chainGateway, fakeOutline, fakeShot, insertChainProject, readChainShots, runChain } from './helpers/shot-chain'
import { LiveCallsBlockedError, type ClaudeGateway } from '../src/lib/claude'

// What one shot-generation run writes, through the chain's outline and chunk calls: the
// title and video type, the assistant message, elements deduped by name, camera origins,
// the project style, the claim's lifecycle and every call's usage row. The chain's
// pacing, limits and charging are tests/shot-chain.spec.ts.

const SHOT_KEY_RE = /^[23456789bcdfghjkmnpqrstvwxz]{5}$/

const RICH_SHOTS = [
  fakeShot('Mara had kept the light for twenty years.', {
    visual_description: 'Wide shot of a lighthouse at dusk.',
    shot_size_origin: 'derived',
    element_names: [{ name: 'Mara', type: 'character', description: 'A lighthouse keeper' }],
  }),
  // Same name as above, different casing - proves case-insensitive dedup.
  fakeShot('One stormy night, she heard a voice on the wind.', { dialogue: [{ speaker_name: 'mara', line: 'Is anyone out there?' }] }),
  // A second, genuinely distinct element - proves non-dedup across different names.
  fakeShot('Her dog was the first to reach the shore.', {
    element_names: [{ name: 'Old Dog', type: 'character', description: 'Her loyal companion' }],
  }),
]

function richGateway(style: unknown[] = []) {
  return chainGateway({
    outline: fakeOutline([{ title: 'The Keeper', seconds: 90, element_names: ['Mara'] }], { title: 'The Lighthouse Keeper', video_type: 'narrated_story', style }),
    chunk: () => ({ shots: RICH_SHOTS, scene_complete: true }),
  })
}

async function readGeneration(projectId: string) {
  const { data, error } = await admin
    .from('generations')
    .select('state, payload')
    .eq('project_id', projectId)
    .eq('step', 'workbench')
    .eq('operation', 'generate_shots')
    .is('shot_id', null)
    .single()
  expect(error).toBeNull()
  return data!
}

async function readUsage(projectId: string) {
  const { data, error } = await admin.from('usage').select('*').eq('project_id', projectId)
  expect(error).toBeNull()
  return data ?? []
}

test.describe('Step 2 workbench - shot generation', () => {
  test('writes the shots, applies the title and video type, inserts an assistant message, and lands on succeeded with the payload cleared', { tag: '@smoke' }, async () => {
    const projectId = await insertChainProject(primary.user.id)
    const { request } = await runChain({ projectId, userId: primary.user.id, gateway: richGateway() })
    expect(request.ok).toBe(true)

    const shots = await readChainShots(projectId)
    expect(shots.length).toBe(RICH_SHOTS.length)
    const { data: keys } = await admin.from('shots').select('shot_key').eq('project_id', projectId)
    expect(new Set(keys!.map((k) => k.shot_key)).size).toBe(keys!.length)
    for (const { shot_key } of keys!) expect(shot_key).toMatch(SHOT_KEY_RE)
    expect(shots.every((s) => s.scenes?.title === 'The Keeper')).toBe(true)

    const { data: project } = await admin.from('projects').select('title, video_type').eq('id', projectId).single()
    expect(project).toEqual({ title: 'The Lighthouse Keeper', video_type: 'narrated_story' })

    expect(await readGeneration(projectId)).toEqual({ state: 'succeeded', payload: null })
    const { data: messages } = await admin.from('messages').select('content').eq('project_id', projectId).eq('role', 'assistant')
    expect(messages!.length).toBeGreaterThan(0)
  })

  test('dedupes an element referenced by name in one shot and by dialogue speaker in another, and resolves dialogue to the deduped element', async () => {
    const projectId = await insertChainProject(primary.user.id)
    await runChain({ projectId, userId: primary.user.id, gateway: richGateway() })
    const { data: elements } = await admin.from('elements').select('id, name').eq('project_id', projectId)
    expect(elements!.map((e) => e.name.toLowerCase()).sort()).toEqual(['mara', 'old dog'])
    const mara = elements!.find((e) => e.name.toLowerCase() === 'mara')!
    const shots = await readChainShots(projectId)
    const { data: dialogue } = await admin.from('shot_dialogue').select('element_id').eq('shot_id', shots[1].id)
    expect(dialogue).toEqual([{ element_id: mara.id }])
  })

  test('persists reported camera origins, and sanitizes an unrecognized origin (including a hypothetical override) to auto', async () => {
    const projectId = await insertChainProject(primary.user.id)
    const gateway = chainGateway({
      outline: fakeOutline([{ title: 'A', seconds: 90 }]),
      chunk: () => ({
        shots: [fakeShot('Narration.', { shot_size_origin: 'derived', camera_movement_origin: 'override' })],
        scene_complete: true,
      }),
    })
    await runChain({ projectId, userId: primary.user.id, gateway })
    const { data } = await admin.from('shots').select('shot_size_origin, camera_angle_origin, camera_movement_origin').eq('project_id', projectId)
    expect(data).toEqual([{ shot_size_origin: 'derived', camera_angle_origin: 'auto', camera_movement_origin: 'auto' }])
  })

  test('a claim that succeeded is refused without retry - 409 retry_required, nothing called', async () => {
    const projectId = await insertChainProject(primary.user.id)
    await runChain({ projectId, userId: primary.user.id, gateway: richGateway() })
    const again = await runChain({ projectId, userId: primary.user.id, gateway: throwingGateway('never'), retry: false })
    expect(again.request).toMatchObject({ ok: false, status: 409, reason: 'retry_required' })
  })

  test('recovery replays a stored outline without calling the gateway again, replacing the existing shots', { tag: '@smoke' }, async () => {
    const projectId = await insertChainProject(primary.user.id)
    await runChain({ projectId, userId: primary.user.id, gateway: richGateway() })
    const before = await readChainShots(projectId)
    // A failed attempt that had already paid for its outline.
    await admin
      .from('generations')
      .update({ state: 'failed', payload: fakeOutline([{ title: 'Recovered', seconds: 90 }]) as never })
      .eq('project_id', projectId)
      .eq('operation', 'generate_shots')
    const gateway = chainGateway({
      outline: fakeOutline([{ title: 'Must not be asked', seconds: 90 }]),
      chunk: () => ({ shots: [fakeShot('After recovery.')], scene_complete: true }),
    })
    await runChain({ projectId, userId: primary.user.id, gateway, retry: true })
    expect(gateway.calls.filter((c) => c.tool === 'write_outline')).toHaveLength(0)
    const after = await readChainShots(projectId)
    expect(after.map((s) => s.voice_over)).toEqual(['After recovery.'])
    expect(after.every((s) => !before.some((b) => b.id === s.id))).toBe(true)
    expect(after[0].scenes!.title).toBe('Recovered')
  })
})

test.describe('Step 2 workbench - shot generation usage rows', () => {
  test('a gateway call that throws still leaves a usage row, failed, with a non-null estimated cost', async () => {
    const projectId = await insertChainProject(primary.user.id)
    await runChain({ projectId, userId: primary.user.id, gateway: throwingGateway('simulated network failure') })
    const usage = await readUsage(projectId)
    expect(usage).toHaveLength(1)
    expect(usage[0]).toMatchObject({ status: 'failed', step: 'workbench', operation: 'generate_shots' })
    expect(usage[0].estimated_cost).not.toBeNull()
    expect((await readGeneration(projectId)).state).toBe('failed')
  })

  test('a pre-network blocked call settles as failed with zero cost, not the quote', { tag: '@smoke' }, async () => {
    const projectId = await insertChainProject(primary.user.id)
    await runChain({ projectId, userId: primary.user.id, gateway: throwingGateway(new LiveCallsBlockedError()) })
    const usage = await readUsage(projectId)
    expect(usage).toHaveLength(1)
    expect(usage[0].status).toBe('failed')
    // Exactly 0: assertLiveCallsAllowed() throws before any request reaches Anthropic.
    expect(usage[0].estimated_cost).toBe(0)
    expect(usage[0].raw_usage).toMatchObject({ blocked: true, billed: false })
  })

  test('every successful call writes one succeeded usage row with a measured cost below the quote', async () => {
    const projectId = await insertChainProject(primary.user.id)
    const gateway = richGateway()
    await runChain({ projectId, userId: primary.user.id, gateway })
    const usage = await readUsage(projectId)
    expect(usage).toHaveLength(gateway.calls.length)
    for (const row of usage) {
      expect(row.status).toBe('succeeded')
      expect(row.quantity).toBe(20) // successMessage's fixed 10 input + 10 output tokens
      expect(Number(row.estimated_cost)).toBeGreaterThan(0)
      expect(Number(row.estimated_cost)).toBeLessThan(Number(row.quoted_cost))
    }
  })

  test('a chunk cut short at max_tokens keeps its saved shots, writes a failed usage row with stop_reason max_tokens, and the run ends failed with the scene left unwritten', async () => {
    const projectId = await insertChainProject(primary.user.id)
    let calls = 0
    const gateway: ClaudeGateway = {
      async createMessage(params) {
        calls++
        const tool = (params.tool_choice as { name: string }).name
        if (tool === 'write_outline') return successMessage(fakeOutline([{ title: 'A', seconds: 90 }]), 'write_outline')
        return truncatedMessage({ shots: [fakeShot('Partial.')], scene_complete: false })
      },
    }
    await runChain({ projectId, userId: primary.user.id, gateway })
    expect(calls).toBe(2)
    expect((await readChainShots(projectId)).map((s) => s.voice_over)).toEqual(['Partial.'])
    const chunkUsage = (await readUsage(projectId)).filter((u) => u.stop_reason === 'max_tokens')
    expect(chunkUsage).toHaveLength(1)
    expect(chunkUsage[0].status).toBe('failed')
    const { data: chunks } = await admin.from('shot_run_chunks').select('status, payload, scene_complete').eq('project_id', projectId)
    expect(chunks).toEqual([{ status: 'failed', payload: null, scene_complete: false }])
    expect((await readGeneration(projectId)).state).toBe('failed')
  })
})

test.describe('Step 2 workbench - the project style', () => {
  test('a single style candidate produces exactly one elements row of type style, never bound to a shot', async () => {
    const projectId = await insertChainProject(primary.user.id)
    await runChain({ projectId, userId: primary.user.id, gateway: richGateway([{ name: 'Warm Nostalgia', description: 'soft colors, warm tones' }]) })
    const { data: styles } = await admin.from('elements').select('id, name, description').eq('project_id', projectId).eq('type', 'style')
    expect(styles!.map((s) => [s.name, s.description])).toEqual([['Warm Nostalgia', 'soft colors, warm tones']])
    const { data: bindings } = await admin.from('shot_elements').select('element_id').eq('element_id', styles![0].id)
    expect(bindings).toHaveLength(0)
  })

  test('more than one style candidate: only the first is inserted, the rest discarded', async () => {
    const projectId = await insertChainProject(primary.user.id)
    await runChain({
      projectId,
      userId: primary.user.id,
      gateway: richGateway([
        { name: 'First Look', description: 'first' },
        { name: 'Second Look', description: 'second' },
      ]),
    })
    const { data: styles } = await admin.from('elements').select('name').eq('project_id', projectId).eq('type', 'style')
    expect(styles).toEqual([{ name: 'First Look' }])
  })

  test('a soft-deleted element with a matching name is not reused - generation inserts a fresh row', async () => {
    const projectId = await insertChainProject(primary.user.id)
    const { data: deleted } = await admin
      .from('elements')
      .insert({ project_id: projectId, name: 'Vintage Film', type: 'style', description: 'old', deleted_at: new Date().toISOString() })
      .select('id')
      .single()
    await runChain({ projectId, userId: primary.user.id, gateway: richGateway([{ name: 'Vintage Film', description: 'a fresh take' }]) })
    const { data: matches } = await admin.from('elements').select('id, deleted_at, description').eq('project_id', projectId).ilike('name', 'Vintage Film')
    expect(matches).toHaveLength(2)
    const fresh = matches!.find((m) => m.id !== deleted!.id)!
    expect(fresh).toMatchObject({ deleted_at: null, description: 'a fresh take' })
  })

  test('a per-shot element colliding by name with the style element fails that chunk loudly instead of binding the style', async () => {
    const projectId = await insertChainProject(primary.user.id)
    const gateway = chainGateway({
      outline: fakeOutline([{ title: 'A', seconds: 90 }], { style: [{ name: 'Echo', description: 'muted tones' }] }),
      chunk: () => ({
        shots: [fakeShot('Narration.', { element_names: [{ name: 'Echo', type: 'prop', description: 'not the style' }] })],
        scene_complete: true,
      }),
    })
    await runChain({ projectId, userId: primary.user.id, gateway })
    expect(await readChainShots(projectId)).toHaveLength(0)
    const { data: chunks } = await admin.from('shot_run_chunks').select('status').eq('project_id', projectId)
    expect(chunks).toEqual([{ status: 'failed' }])
  })
})
