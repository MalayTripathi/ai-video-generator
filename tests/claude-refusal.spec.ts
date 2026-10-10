import { test, expect } from '@playwright/test'
import { admin } from './supabase-test-session'
import { primary } from './fixed-users'
import { stepIndex } from '../src/lib/config/pipeline'
import { refusalMessage, scriptedGateway } from './helpers/claude-fakes'
import { realRecordDynamicSpend, realRecordFixedSpend } from './helpers/ledger-child'
import { chainGateway, fakeOutline, fakeShot, insertChainProject, parseChunkAsk, readChainShots, readRun, runChain } from './helpers/shot-chain'
import type { ClaudeGateway } from '../src/lib/claude'
import { REFUSAL_USER_MESSAGE } from '../src/lib/claude'
import { CAMERA_FIELD_NAMES } from '../src/lib/prompts/camera-derivation'
import { runImagePromptGeneration } from '../src/app/api/projects/[id]/image-prompts/logic'
import { runCameraDerivation } from '../src/app/api/projects/[id]/shots/[shotId]/camera/logic'
import { runMusicPromptDerivation } from '../src/app/api/projects/[id]/music/logic'
import { AGENT_REFUSAL_REPLY, runAgentTurn } from '../src/app/api/projects/[id]/agent/logic'
import { getAgentStepConfig } from '../src/app/api/projects/[id]/agent/steps'

// A safety-classifier refusal on every Claude route settles exactly like a failed call:
// nothing partial is saved (even when a mid-stream decline carries the start of a tool
// call), no credit_ledger row is written, the usage row settles 'failed' with
// stop_reason 'refusal', and any claim is released. Every assertion is scoped to the
// project the test just created.

const REAL_LEDGER = { recordFixedSpend: realRecordFixedSpend, recordDynamicSpend: realRecordDynamicSpend }

async function seedProject(overrides: Record<string, unknown> = {}) {
  const { data, error } = await admin
    .from('projects')
    .insert({
      user_id: primary.user.id,
      title: 'Refusal test',
      source_text: 'A short film used by the refusal tests.',
      video_type: 'auto',
      duration_target: '30-60s',
      video_model: 'wan-3.0',
      language: 'en',
      current_step: 'workbench',
      furthest_step: stepIndex('workbench'),
      ...overrides,
    })
    .select('id')
    .single()
  expect(error).toBeNull()
  return data!.id as string
}

async function seedShot(projectId: string, overrides: Record<string, unknown> = {}) {
  const { data, error } = await admin
    .from('shots')
    .insert({
      project_id: projectId,
      order_index: 0,
      shot_key: 'bcdfg',
      voice_over: 'The river rises at dawn.',
      visual_description: 'A wide shot of a river at dawn.',
      duration_sec: 5,
      ...overrides,
    })
    .select('id')
    .single()
  expect(error).toBeNull()
  return data!.id as string
}

async function rowsFor(projectId: string) {
  const [usage, ledger, generations] = await Promise.all([
    admin.from('usage').select('operation, status, stop_reason').eq('project_id', projectId),
    admin.from('credit_ledger').select('id').eq('project_id', projectId),
    admin.from('generations').select('operation, state, payload').eq('project_id', projectId),
  ])
  return { usage: usage.data ?? [], ledger: ledger.data ?? [], generations: generations.data ?? [] }
}

test.describe('refusals settle like a failed call', () => {
  test('image prompts: a mid-stream refusal persists nothing, charges nothing and releases the claim', async () => {
    const projectId = await seedProject()
    const shotId = await seedShot(projectId, { image_prompt: null, image_prompt_stale: true })
    const gateway = scriptedGateway([
      refusalMessage({
        partialToolUse: { name: 'write_image_prompts', input: { prompts: [{ shot_key: 'bcdfg', image_prompt: 'A partial prompt' }] } },
      }),
    ])

    const result = await runImagePromptGeneration({
      gateway,
      supabase: admin,
      projectId,
      userId: primary.user.id,
      shotIds: [shotId],
      retry: false,
      attemptId: crypto.randomUUID(),
      recordFixedSpend: realRecordFixedSpend,
      getBalance: async () => 999999,
      ensureSignupGrant: async () => {},
    })
    expect(result).toMatchObject({ ok: false, status: 422, error: REFUSAL_USER_MESSAGE })

    const { data: shot } = await admin.from('shots').select('image_prompt').eq('id', shotId).single()
    expect(shot!.image_prompt).toBeNull()
    const rows = await rowsFor(projectId)
    expect(rows.ledger).toEqual([])
    expect(rows.usage).toEqual([{ operation: 'write_image_prompts', status: 'failed', stop_reason: 'refusal' }])
    expect(rows.generations).toEqual([{ operation: 'write_image_prompts', state: 'failed', payload: null }])
  })

  test('camera: a mid-stream refusal applies nothing and charges nothing', async () => {
    const projectId = await seedProject()
    const shotId = await seedShot(projectId, { shot_size: 'medium', shot_size_origin: 'auto' })
    const gateway = scriptedGateway([
      refusalMessage({ partialToolUse: { name: 'derive_camera', input: { shot_size: 'wide', shot_size_origin: 'derived' } } }),
    ])

    const result = await runCameraDerivation({
      gateway,
      supabase: admin,
      projectId,
      shotId,
      userId: primary.user.id,
      fields: [...CAMERA_FIELD_NAMES],
      attemptId: crypto.randomUUID(),
      recordFixedSpend: realRecordFixedSpend,
    })
    expect(result).toMatchObject({ ok: false, status: 422, error: REFUSAL_USER_MESSAGE })

    const { data: shot } = await admin.from('shots').select('shot_size, shot_size_origin').eq('id', shotId).single()
    expect(shot).toEqual({ shot_size: 'medium', shot_size_origin: 'auto' })
    const rows = await rowsFor(projectId)
    expect(rows.ledger).toEqual([])
    expect(rows.usage).toEqual([{ operation: 'derive_camera', status: 'failed', stop_reason: 'refusal' }])
  })

  test('music prompt: a refusal stores nothing and releases the claim', async () => {
    const projectId = await seedProject({ current_step: 'storyboard', furthest_step: stepIndex('storyboard'), music_style_prompt: null })
    await seedShot(projectId)
    const gateway = scriptedGateway([
      refusalMessage({ partialToolUse: { name: 'write_music_style', input: { style: 'Partial style' } } }),
    ])

    const result = await runMusicPromptDerivation({ supabase: admin, gateway, projectId, userId: primary.user.id })
    expect(result).toMatchObject({ ok: false, status: 422, error: REFUSAL_USER_MESSAGE })

    const { data: project } = await admin.from('projects').select('music_style_prompt').eq('id', projectId).single()
    expect(project!.music_style_prompt).toBeNull()
    const rows = await rowsFor(projectId)
    expect(rows.ledger).toEqual([])
    expect(rows.usage).toEqual([{ operation: 'derive_music_prompt', status: 'failed', stop_reason: 'refusal' }])
    expect(rows.generations).toEqual([{ operation: 'derive_music_prompt', state: 'failed', payload: null }])
  })

  test('agent: a refused call fails the turn - refusal reply, no ledger row, claim released', async () => {
    const projectId = await seedProject()
    await seedShot(projectId)
    const gateway = scriptedGateway([{ ...refusalMessage(), deltas: ['Partial text'] }])

    const result = await runAgentTurn({
      config: getAgentStepConfig('workbench'),
      gateway,
      supabase: admin,
      projectId,
      userId: primary.user.id,
      content: 'rewrite the first shot',
      clientId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      recordTurnSpend: realRecordDynamicSpend,
    })
    expect(result).toMatchObject({ ok: false, status: 422, error: AGENT_REFUSAL_REPLY })

    const { data: messages } = await admin
      .from('messages')
      .select('role, content')
      .eq('project_id', projectId)
      .eq('role', 'assistant')
    expect(messages!.map((m) => m.content)).toEqual([AGENT_REFUSAL_REPLY])
    const rows = await rowsFor(projectId)
    expect(rows.ledger).toEqual([])
    expect(rows.usage).toEqual([{ operation: 'agent_turn', status: 'failed', stop_reason: 'refusal' }])
    expect(rows.generations).toEqual([expect.objectContaining({ operation: 'agent_turn', state: 'failed' })])
  })

  test('shots: a refused outline ends the run refused - nothing persisted, nothing charged', async () => {
    const projectId = await insertChainProject(primary.user.id, { duration_target: '30-60s' })
    const gateway = scriptedGateway([
      refusalMessage({ partialToolUse: { name: 'write_outline', input: fakeOutline([{ title: 'Scene 1', seconds: 40 }]) } }),
    ])

    const { request, runs } = await runChain({ projectId, userId: primary.user.id, gateway, ledger: REAL_LEDGER })
    expect(request.ok).toBe(true)
    expect(runs.at(-1)!.result).toMatchObject({ outcome: 'finished', status: 'failed', stopReason: 'refused' })

    const run = await readRun((request as { runId: string }).runId)
    expect(run.stop_reason).toBe('refused')
    expect(await readChainShots(projectId)).toEqual([])
    const rows = await rowsFor(projectId)
    expect(rows.ledger).toEqual([])
    expect(rows.usage).toEqual([{ operation: 'generate_shots', status: 'failed', stop_reason: 'refusal' }])
    expect(rows.generations).toEqual([expect.objectContaining({ operation: 'generate_shots', state: 'failed', payload: null })])
  })

  test('shots: a refused chunk saves none of its partial shots and is not charged; the other scene is', async () => {
    const projectId = await insertChainProject(primary.user.id, { duration_target: '30-60s' })
    const inner = chainGateway({
      outline: fakeOutline([
        { title: 'Scene 1', seconds: 20 },
        { title: 'Scene 2', seconds: 20 },
      ]),
      chunk: (ask) => ({ shots: [fakeShot(`s${ask.scenePosition} spoken words here`)], scene_complete: true }),
    })
    const gateway: ClaudeGateway = {
      async createMessage(params, hooks) {
        const result = await inner.createMessage(params, hooks)
        const tool = (params.tool_choice as { name?: string } | undefined)?.name
        // Scene 2's chunk is declined mid-stream, its write_shots half-written.
        if (tool === 'write_shots' && parseChunkAsk(params).scenePosition === 1) {
          return refusalMessage({ partialToolUse: { name: 'write_shots', input: { shots: [fakeShot('partial spoken words here')] } } })
        }
        return result
      },
    }

    const { request, runs } = await runChain({ projectId, userId: primary.user.id, gateway, ledger: REAL_LEDGER, concurrency: 1 })
    expect(request.ok).toBe(true)
    expect(runs.at(-1)!.result).toMatchObject({ outcome: 'finished', status: 'failed', stopReason: 'refused' })

    const shots = await readChainShots(projectId)
    expect(shots.map((s) => s.voice_over)).toEqual(['s0 spoken words here'])
    const rows = await rowsFor(projectId)
    const usage = rows.usage.filter((u) => u.stop_reason === 'refusal')
    expect(usage).toEqual([{ operation: 'generate_shots', status: 'failed', stop_reason: 'refusal' }])
    // The saved shot is charged once; the refused chunk adds nothing.
    const { data: ledger } = await admin.from('credit_ledger').select('delta').eq('project_id', projectId)
    expect(ledger!.length).toBe(1)
    expect(ledger![0].delta).toBe(-2)
  })
})
