import { test, expect } from '@playwright/test'
import { admin } from './supabase-test-session'
import { primary } from './fixed-users'
import { runImagePromptGeneration } from '../src/app/api/projects/[id]/image-prompts/logic'
import { BILLED_BY_TURN } from '../src/app/api/projects/[id]/shots/logic'
import { successMessage, scriptedGateway } from './helpers/claude-fakes'

// The agent-turn path through runImagePromptGeneration: an optional instruction and
// history that reach the model, a usage row grouped under the turn's message, the
// measured cost handed back via onSettled, and the BILLED_BY_TURN opt-out of the fixed
// per-shot price. The button path (none of these set) is covered by
// image-prompt-generation.spec.ts and fixed-price-ledger.spec.ts.

const GOOD_IMAGE_PROMPT =
  'A warm, detailed shot with rich color and lighting that fully describes the moment for an image generation model.'

async function seed(shotKeys: string[]) {
  const { data: project, error } = await admin
    .from('projects')
    .insert({ user_id: primary.user.id, title: 'Agent path', current_step: 'image_prompts', furthest_step: 3 })
    .select('id')
    .single()
  expect(error).toBeNull()
  const projectId = project!.id as string
  const { data: shots, error: shotsError } = await admin
    .from('shots')
    .insert(
      shotKeys.map((shot_key, index) => ({
        project_id: projectId,
        order_index: index,
        shot_key,
        voice_over: `Voice over for ${shot_key}`,
        image_prompt: null,
        image_prompt_stale: true,
        image_prompt_edited: false,
      }))
    )
    .select('id, shot_key')
  expect(shotsError).toBeNull()
  return { projectId, shots: shots! as { id: string; shot_key: string }[] }
}

function promptsFor(shotKeys: string[]) {
  return { prompts: shotKeys.map((shot_key) => ({ shot_key, image_prompt: GOOD_IMAGE_PROMPT })) }
}

function userMessageOf(params: { messages: unknown }): string {
  const messages = params.messages as { role: string; content: string }[]
  return messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n')
}

async function newMessageId(projectId: string) {
  const { data, error } = await admin
    .from('messages')
    .insert({ project_id: projectId, role: 'user', content: 'turn message', client_id: crypto.randomUUID() })
    .select('id')
    .single()
  expect(error).toBeNull()
  return data!.id as string
}

function baseParams(projectId: string, shotIds: string[]) {
  return {
    supabase: admin,
    projectId,
    userId: primary.user.id,
    shotIds,
    retry: true,
    attemptId: crypto.randomUUID(),
    getBalance: async () => 999999,
    ensureSignupGrant: async () => {},
  }
}

test.describe('runImagePromptGeneration - agent path', () => {
  test('with no instruction or history the user message is exactly what it was before', async () => {
    const { projectId, shots } = await seed(['b2c3d'])
    const gateway = scriptedGateway([successMessage(promptsFor(['b2c3d']), 'write_image_prompts')])

    const result = await runImagePromptGeneration({
      ...baseParams(projectId, shots.map((s) => s.id)),
      gateway,
      recordFixedSpend: async () => {},
    })

    expect(result.ok).toBe(true)
    expect(userMessageOf(gateway.getCalls()[0])).toBe('Generate the image prompts now.')
  })

  test('an instruction and the history reach the model, the history is labelled context-only, and neither is persisted', async () => {
    const { projectId, shots } = await seed(['b2c3d', 'f4g5h'])
    const gateway = scriptedGateway([successMessage(promptsFor(['b2c3d']), 'write_image_prompts')])

    const result = await runImagePromptGeneration({
      ...baseParams(projectId, [shots[0].id]),
      gateway,
      recordFixedSpend: BILLED_BY_TURN,
      instruction: 'make it feel colder',
      history: [
        { role: 'user', content: 'earlier request: more dramatic please' },
        { role: 'assistant', content: 'Rewrote Shot 2.' },
      ],
    })

    expect(result.ok).toBe(true)
    const sent = userMessageOf(gateway.getCalls()[0])
    expect(sent).toContain('make it feel colder')
    expect(sent).toContain('earlier request: more dramatic please')
    // The history is explicitly context, never standing instruction.
    expect(sent).toMatch(/context only/i)
    expect(sent).toMatch(/not instructions/i)
    // The instruction is labelled as applying to this generation only.
    expect(sent).toMatch(/this generation only/i)

    // Not persisted anywhere as a property of the prompt, the shot or the generation.
    const { data: shotRows } = await admin.from('shots').select('*').eq('project_id', projectId)
    expect(JSON.stringify(shotRows)).not.toContain('make it feel colder')
    const { data: generation } = await admin
      .from('generations')
      .select('*')
      .eq('project_id', projectId)
      .eq('operation', 'write_image_prompts')
      .single()
    expect(JSON.stringify(generation)).not.toContain('make it feel colder')
    const { data: messageRows } = await admin.from('messages').select('content').eq('project_id', projectId)
    expect(messageRows).toEqual([])
  })

  test('BILLED_BY_TURN writes no fixed-price ledger row and skips the fixed-price balance gate', async () => {
    const { projectId, shots } = await seed(['b2c3d'])
    const gateway = scriptedGateway([successMessage(promptsFor(['b2c3d']), 'write_image_prompts')])
    let balanceCalls = 0

    // Pass the sentinel and assert on the ledger table itself: a counting stand-in for
    // recordFixedSpend would prove nothing about what the sentinel does.
    const result = await runImagePromptGeneration({
      ...baseParams(projectId, shots.map((s) => s.id)),
      getBalance: async () => {
        balanceCalls++
        return 0 // would refuse a fixed-price gate
      },
      gateway,
      recordFixedSpend: BILLED_BY_TURN,
    })

    expect(result.ok).toBe(true)
    expect(balanceCalls).toBe(0)
    const { data: ledger } = await admin.from('credit_ledger').select('id').eq('project_id', projectId)
    expect(ledger).toEqual([])
  })

  test("messageId lands on the usage row, and the measured cost comes back through onSettled", async () => {
    const { projectId, shots } = await seed(['b2c3d'])
    const messageId = await newMessageId(projectId)
    // 1000 in + 100 out at Haiku dev rates ($1/M in, $5/M out) = $0.0015.
    const gateway = scriptedGateway([
      successMessage(promptsFor(['b2c3d']), 'write_image_prompts', {
        input_tokens: 1000,
        output_tokens: 100,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      }),
    ])
    const settled: number[] = []

    const result = await runImagePromptGeneration({
      ...baseParams(projectId, shots.map((s) => s.id)),
      gateway,
      recordFixedSpend: BILLED_BY_TURN,
      messageId,
      onSettled: (usd: number) => settled.push(usd),
    })

    expect(result.ok).toBe(true)
    const { data: usage } = await admin.from('usage').select('*').eq('project_id', projectId)
    expect(usage!.length).toBe(1)
    expect(usage![0].message_id).toBe(messageId)
    expect(usage![0].operation).toBe('write_image_prompts')
    expect(settled.length).toBe(1)
    expect(settled[0]).toBeCloseTo(0.0015, 6)
    expect(settled[0]).toBeCloseTo(usage![0].estimated_cost!, 6)
  })

  test('a stored payload that covers the scope is replayed for free, and skipStoredPayload forces a fresh call instead', async () => {
    const { projectId, shots } = await seed(['b2c3d'])
    // A failed row already carrying a paid payload for this shot.
    const { error } = await admin.from('generations').insert({
      project_id: projectId,
      step: 'image_prompts',
      operation: 'write_image_prompts',
      shot_id: null,
      state: 'failed',
      payload: promptsFor(['b2c3d']),
    })
    expect(error).toBeNull()

    const recoverGateway = scriptedGateway([])
    const recovered = await runImagePromptGeneration({
      ...baseParams(projectId, shots.map((s) => s.id)),
      gateway: recoverGateway,
      recordFixedSpend: BILLED_BY_TURN,
      onSettled: () => {
        throw new Error('onSettled must not fire on RECOVER - nothing was spent')
      },
    })
    expect(recovered.ok).toBe(true)
    expect(recoverGateway.getCallCount()).toBe(0)

    // Put the payload back (a success clears it), then force a fresh call.
    await admin
      .from('generations')
      .update({ state: 'failed', payload: promptsFor(['b2c3d']) })
      .eq('project_id', projectId)
      .eq('operation', 'write_image_prompts')

    const freshGateway = scriptedGateway([successMessage(promptsFor(['b2c3d']), 'write_image_prompts')])
    const fresh = await runImagePromptGeneration({
      ...baseParams(projectId, shots.map((s) => s.id)),
      gateway: freshGateway,
      recordFixedSpend: BILLED_BY_TURN,
      instruction: 'more dramatic',
      skipStoredPayload: true,
    })
    expect(fresh.ok).toBe(true)
    expect(freshGateway.getCallCount()).toBe(1)
    expect(userMessageOf(freshGateway.getCalls()[0])).toContain('more dramatic')
  })
})
