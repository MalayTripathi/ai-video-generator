import { test, expect } from '@playwright/test'
import { admin } from './supabase-test-session'
import { primary } from './fixed-users'
import { successMessage, textMessage, scriptedGateway } from './helpers/claude-fakes'
import { realRecordDynamicSpend } from './helpers/ledger-child'
import { runAgentTurn } from '../src/app/api/projects/[id]/agent/logic'
import { getAgentStepConfig } from '../src/app/api/projects/[id]/agent/steps'
import { TOOL_NAMES } from '../src/lib/config/messages'
import { describeToolActivity } from '../src/lib/agent-activity-display'
import { IMAGE_PROMPTS_INSTRUCTION_MAX_CHARS } from '../src/lib/prompts/image-prompts'

// Step 3's agent tools: regenerate_all_image_prompts / regenerate_image_prompt. Every model
// call is a scripted fake (never the real SDK - see CLAUDE.md), and the ledger write goes
// through the real recordDynamicSpend.

const GOOD_PROMPT =
  'A cold, blue-toned wide shot of the harbour at dawn, mist on the water, documentary framing, muted palette, no people.'

// Haiku dev rates: input $1/M, output $5/M. These three calls cost $0.0015 + $0.0015 +
// $0.0009 = $0.0039 -> 4 credits rounded once on the total. Rounding per call would give
// 2 + 2 + 1 = 5, so the delta distinguishes the two.
const usage = (inputTokens: number, outputTokens: number) => ({
  input_tokens: inputTokens,
  output_tokens: outputTokens,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
})

const generousBalance = { getBalance: async () => 999_999, ensureSignupGrant: async () => {} }

async function seedProject(overrides: Record<string, unknown> = {}) {
  const { data, error } = await admin
    .from('projects')
    .insert({
      user_id: primary.user.id,
      title: 'Step 3 agent',
      source_text: 'A short film about a harbour.',
      video_type: 'auto',
      duration_target: '30-60s',
      current_step: 'image_prompts',
      furthest_step: 3,
      ...overrides,
    })
    .select('id')
    .single()
  expect(error).toBeNull()
  return data!.id as string
}

async function seedShots(projectId: string, count: number, overrides: Record<string, unknown> = {}) {
  const rows = Array.from({ length: count }, (_, i) => ({
    project_id: projectId,
    order_index: i,
    shot_key: `ag${i}${crypto.randomUUID().slice(0, 2).replace(/[^a-z]/g, 'b')}`.slice(0, 5),
    voice_over: `Voice over ${i + 1}.`,
    image_prompt: 'An older prompt that will be replaced.',
    image_prompt_stale: true,
    image_prompt_edited: false,
    ...overrides,
  }))
  const { data, error } = await admin.from('shots').insert(rows).select('id, shot_key, order_index')
  expect(error).toBeNull()
  return data!.sort((a, b) => a.order_index - b.order_index) as { id: string; shot_key: string; order_index: number }[]
}

function turn(projectId: string, gateway: ReturnType<typeof scriptedGateway>, content: string, extra: Record<string, unknown> = {}) {
  return runAgentTurn({
    config: getAgentStepConfig('image_prompts'),
    gateway,
    supabase: admin,
    projectId,
    userId: primary.user.id,
    content,
    clientId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    recordTurnSpend: realRecordDynamicSpend,
    ...generousBalance,
    ...extra,
  })
}

async function ledgerRows(projectId: string) {
  const { data, error } = await admin.from('credit_ledger').select('*').eq('project_id', projectId)
  expect(error).toBeNull()
  return data ?? []
}
async function usageRows(projectId: string) {
  const { data, error } = await admin.from('usage').select('*').eq('project_id', projectId)
  expect(error).toBeNull()
  return data ?? []
}
async function generationRows(projectId: string) {
  const { data, error } = await admin.from('generations').select('*').eq('project_id', projectId)
  expect(error).toBeNull()
  return data ?? []
}
async function messageRows(projectId: string) {
  const { data, error } = await admin
    .from('messages')
    .select('*')
    .eq('project_id', projectId)
    .order('created_at', { ascending: true })
  expect(error).toBeNull()
  return data ?? []
}
function userMessageOfCall(call: { messages: unknown }): string {
  return (call.messages as { role: string; content: unknown }[])
    .filter((m) => m.role === 'user' && typeof m.content === 'string')
    .map((m) => m.content as string)
    .join('\n')
}

test.describe('the Step 3 agent tool set', () => {
  test('is exactly the two regeneration tools plus decline - no binding tool, no tool that writes prompt text', () => {
    const config = getAgentStepConfig('image_prompts')
    expect(config.tools.map((t) => t.name)).toEqual([
      'regenerate_all_image_prompts',
      'regenerate_image_prompt',
      'decline',
    ])
    expect(config.step).toBe('image_prompts')
    for (const name of ['regenerate_all_image_prompts', 'regenerate_image_prompt']) {
      expect(TOOL_NAMES as readonly string[]).toContain(name)
    }
  })

  test('both regeneration tools take an optional instruction; the single one requires a shot_number', () => {
    const tools = getAgentStepConfig('image_prompts').tools
    const all = tools.find((t) => t.name === 'regenerate_all_image_prompts')!.input_schema as {
      properties: Record<string, unknown>
      required?: string[]
    }
    const one = tools.find((t) => t.name === 'regenerate_image_prompt')!.input_schema as {
      properties: Record<string, unknown>
      required?: string[]
    }
    expect(Object.keys(all.properties)).toEqual(expect.arrayContaining(['instruction', 'stored_result']))
    expect(all.required ?? []).toEqual([])
    expect(Object.keys(one.properties)).toEqual(expect.arrayContaining(['shot_number', 'instruction', 'stored_result']))
    expect(one.required).toEqual(['shot_number'])
  })

  test('the Workbench config is unchanged: same tools, no balance gate', () => {
    const config = getAgentStepConfig('workbench')
    expect(config.tools.map((t) => t.name)).toEqual([
      'get_shot',
      'update_shot',
      'insert_shot',
      'regenerate_all_shots',
      'decline',
    ])
    expect(config.toolEstimateUsd).toBeUndefined()
  })

  test('tool_done text for the two tools re-derives live, with the current shot number', () => {
    expect(describeToolActivity('regenerate_image_prompt', 2, 'x')).toBe('Rewrote Shot 2 prompt')
    expect(describeToolActivity('regenerate_all_image_prompts', null, 'x')).toBe('Rewrote all image prompts')
  })

  test('an unknown step is rejected rather than defaulted', () => {
    expect(() => getAgentStepConfig('storyboard' as never)).toThrow()
  })
})

test.describe('runAgentTurn - Step 3 regeneration tools', () => {
  test('regenerate_image_prompt: one agent_turn ledger row for the whole turn, none for write_image_prompts', async () => {
    const projectId = await seedProject()
    const shots = await seedShots(projectId, 3)
    const target = shots[1]

    const gateway = scriptedGateway([
      successMessage({ shot_number: 2, instruction: 'make it feel colder' }, 'regenerate_image_prompt', usage(500, 200)),
      // The nested write_image_prompts call the tool triggers - same shared gateway.
      successMessage(
        { prompts: [{ shot_key: target.shot_key, image_prompt: GOOD_PROMPT }] },
        'write_image_prompts',
        usage(1000, 100)
      ),
      textMessage('Rewrote it colder.', usage(400, 100)),
    ])

    const result = await turn(projectId, gateway, 'make shot 2 feel colder')
    expect(result.ok).toBe(true)
    expect(gateway.getCallCount()).toBe(3)

    const ledger = await ledgerRows(projectId)
    expect(ledger.length).toBe(1)
    expect(ledger[0].operation).toBe('agent_turn')
    expect(ledger[0].step).toBe('image_prompts')
    expect(ledger[0].pricing_mode).toBe('dynamic')
    expect(ledger[0].delta).toBe(-4)
    expect(ledger.some((r) => r.operation === 'write_image_prompts')).toBe(false)

    // The ledger row and every paid call share the turn's own user message id.
    const userMsg = (await messageRows(projectId)).find((m) => m.role === 'user')!
    expect(ledger[0].message_id).toBe(userMsg.id)
    const usage_ = await usageRows(projectId)
    expect(usage_.map((r) => r.operation).sort()).toEqual(['agent_turn', 'agent_turn', 'write_image_prompts'])
    expect(new Set(usage_.map((r) => r.message_id))).toEqual(new Set([userMsg.id]))

    // Only the target shot was rewritten.
    const { data: rows } = await admin.from('shots').select('shot_key, image_prompt').eq('project_id', projectId)
    const byKey = new Map(rows!.map((r) => [r.shot_key, r.image_prompt]))
    expect(byKey.get(target.shot_key)).toBe(GOOD_PROMPT)
    expect(byKey.get(shots[0].shot_key)).toBe('An older prompt that will be replaced.')

    // No write_image_prompts fixed-price generations row was ever the billing surface.
    const gens = await generationRows(projectId)
    expect(gens.some((g) => g.operation === 'agent_turn')).toBe(true)
  })

  test('regenerate_all_image_prompts: one agent_turn ledger row, every shot rewritten', async () => {
    const projectId = await seedProject()
    const shots = await seedShots(projectId, 3)

    const gateway = scriptedGateway([
      successMessage({}, 'regenerate_all_image_prompts', usage(500, 200)),
      successMessage(
        { prompts: shots.map((s) => ({ shot_key: s.shot_key, image_prompt: GOOD_PROMPT })) },
        'write_image_prompts',
        usage(1000, 100)
      ),
      textMessage('Rewrote all of them.', usage(400, 100)),
    ])

    const result = await turn(projectId, gateway, 'rewrite every prompt')
    expect(result.ok).toBe(true)

    const ledger = await ledgerRows(projectId)
    expect(ledger.length).toBe(1)
    expect(ledger[0].operation).toBe('agent_turn')
    expect(ledger[0].delta).toBe(-4)
    expect(ledger.some((r) => r.operation === 'write_image_prompts')).toBe(false)

    const { data: rows } = await admin.from('shots').select('image_prompt').eq('project_id', projectId)
    expect(rows!.every((r) => r.image_prompt === GOOD_PROMPT)).toBe(true)
  })

  // The nested call is paid the moment it returns, whatever it returns. When it spends and
  // then fails or only half-lands, its cost still belongs to this turn: the usage row
  // carries the turn's message_id (so the USD line counts it), and the one ledger charge
  // must count it too - otherwise the two figures disagree and the user is under-billed.
  // 3 calls: $0.0015 + $0.0015 (nested) + $0.0009 = $0.0039 -> 4 credits; dropping the
  // nested call would bill $0.0024 -> 3.
  for (const tool of ['regenerate_all_image_prompts', 'regenerate_image_prompt'] as const) {
    test(`${tool}: a nested call that spends then returns only part of the answer is still billed into the turn's one charge`, async () => {
      const projectId = await seedProject()
      const shots = await seedShots(projectId, 2)
      const input = tool === 'regenerate_image_prompt' ? { shot_number: 1 } : {}
      // Only one prompt comes back: for regenerate_all that leaves one shot missing (422);
      // for the single tool the one requested shot is the one absent.
      const returned = tool === 'regenerate_image_prompt' ? [] : [{ shot_key: shots[0].shot_key, image_prompt: GOOD_PROMPT }]

      const gateway = scriptedGateway([
        successMessage(input, tool, usage(500, 200)),
        successMessage({ prompts: returned }, 'write_image_prompts', usage(1000, 100)),
        textMessage('Not all of it landed.', usage(400, 100)),
      ])
      let settledUsd = -1
      const result = await turn(projectId, gateway, 'redo them', {
        onEvent: (e: { type: string; cost?: number }) => {
          if (e.type === 'settled') settledUsd = e.cost!
        },
      })
      expect(result.ok).toBe(true)

      const usage_ = await usageRows(projectId)
      const nested = usage_.find((r) => r.operation === 'write_image_prompts')!
      expect(nested.estimated_cost).toBeGreaterThan(0)
      expect(nested.message_id).not.toBeNull()
      // The USD figure counts all three calls...
      expect(settledUsd).toBeCloseTo(0.0039, 6)
      // ...and so must the single ledger charge (4 credits, not 3).
      const ledger = await ledgerRows(projectId)
      expect(ledger.length).toBe(1)
      expect(ledger[0].delta).toBe(-4)
    })
  }

  test('a nested call that never spends (unknown shot) adds nothing to the charge', async () => {
    const projectId = await seedProject()
    await seedShots(projectId, 1)
    const gateway = scriptedGateway([
      successMessage({ shot_number: 9 }, 'regenerate_image_prompt', usage(500, 200)),
      textMessage('No such shot.', usage(400, 100)),
    ])
    expect((await turn(projectId, gateway, 'redo shot 9')).ok).toBe(true)
    // $0.0015 + $0.0009 = $0.0024 -> 3 credits: only the two agent calls.
    const ledger = await ledgerRows(projectId)
    expect(ledger.length).toBe(1)
    expect(ledger[0].delta).toBe(-3)
  })

  test('progress lines are persisted as tool_done rows naming the tool and the shot', async () => {
    const projectId = await seedProject()
    const shots = await seedShots(projectId, 2)
    const gateway = scriptedGateway([
      successMessage({ shot_number: 2 }, 'regenerate_image_prompt'),
      successMessage({ prompts: [{ shot_key: shots[1].shot_key, image_prompt: GOOD_PROMPT }] }, 'write_image_prompts'),
      textMessage('Done.'),
    ])
    await turn(projectId, gateway, 'redo shot 2')

    const done = (await messageRows(projectId)).filter((m) => m.kind === 'tool_done')
    expect(done.length).toBe(1)
    expect(done[0].tool_name).toBe('regenerate_image_prompt')
    expect(done[0].shot_key).toBe(shots[1].shot_key)
  })

  test('the instruction reaches the generation, history rides along as context only, and the instruction is persisted nowhere but the chat message', async () => {
    const projectId = await seedProject()
    const shots = await seedShots(projectId, 2)

    const gateway = scriptedGateway([
      successMessage({ shot_number: 1, instruction: 'make it feel colder' }, 'regenerate_image_prompt'),
      successMessage({ prompts: [{ shot_key: shots[0].shot_key, image_prompt: GOOD_PROMPT }] }, 'write_image_prompts'),
      textMessage('Done.'),
    ])
    const result = await turn(projectId, gateway, 'redo shot 1 and make it feel colder')
    expect(result.ok).toBe(true)

    // Call index 1 is the nested write_image_prompts request.
    const nested = userMessageOfCall(gateway.getCalls()[1])
    expect(nested).toContain('make it feel colder')
    expect(nested).toMatch(/this generation only/i)

    // Persisted nowhere as a property of the prompt, the shot, the generation, or any
    // assistant/tool message: only the user's own chat message may carry the words.
    const { data: shotRows } = await admin.from('shots').select('*').eq('project_id', projectId)
    expect(JSON.stringify(shotRows)).not.toContain('make it feel colder')
    expect(JSON.stringify(await generationRows(projectId))).not.toContain('make it feel colder')
    const withPhrase = (await messageRows(projectId)).filter((m) => m.content.includes('make it feel colder'))
    expect(withPhrase.map((m) => m.role)).toEqual(['user'])
  })

  test("a later turn's generation shows the earlier request only as context-only history, and carries no instruction block unless the tool call passes one", async () => {
    const projectId = await seedProject()
    const shots = await seedShots(projectId, 2)

    const first = scriptedGateway([
      successMessage({ shot_number: 1, instruction: 'make it feel colder' }, 'regenerate_image_prompt'),
      successMessage({ prompts: [{ shot_key: shots[0].shot_key, image_prompt: GOOD_PROMPT }] }, 'write_image_prompts'),
      textMessage('Colder.'),
    ])
    expect((await turn(projectId, first, 'make shot 1 feel colder')).ok).toBe(true)

    // Second turn: the model calls the tool with NO instruction.
    const second = scriptedGateway([
      successMessage({ shot_number: 2 }, 'regenerate_image_prompt'),
      successMessage({ prompts: [{ shot_key: shots[1].shot_key, image_prompt: GOOD_PROMPT }] }, 'write_image_prompts'),
      textMessage('Redone.'),
    ])
    expect((await turn(projectId, second, 'redo shot 2')).ok).toBe(true)

    const nested = userMessageOfCall(second.getCalls()[1])
    // The earlier request is visible as history...
    expect(nested).toContain('make shot 1 feel colder')
    expect(nested).toMatch(/context only/i)
    // ...but there is no instruction block for this generation.
    expect(nested).not.toMatch(/Instruction for this generation only/)
  })

  test('agent regeneration clears EDITED BY YOU and stale, like any successful generation', async () => {
    const projectId = await seedProject()
    const shots = await seedShots(projectId, 1, { image_prompt: 'My own hand-written prompt.', image_prompt_edited: true, image_prompt_stale: true })

    const gateway = scriptedGateway([
      successMessage({ shot_number: 1 }, 'regenerate_image_prompt'),
      successMessage({ prompts: [{ shot_key: shots[0].shot_key, image_prompt: GOOD_PROMPT }] }, 'write_image_prompts'),
      textMessage('Done.'),
    ])
    expect((await turn(projectId, gateway, 'redo shot 1')).ok).toBe(true)

    const { data } = await admin
      .from('shots')
      .select('image_prompt, image_prompt_edited, image_prompt_stale')
      .eq('id', shots[0].id)
      .single()
    expect(data).toEqual({ image_prompt: GOOD_PROMPT, image_prompt_edited: false, image_prompt_stale: false })
  })

  test('an unknown shot number is a not-found error to the model, never a write or a charge', async () => {
    const projectId = await seedProject()
    await seedShots(projectId, 1)
    const gateway = scriptedGateway([
      successMessage({ shot_number: 9 }, 'regenerate_image_prompt'),
      textMessage('That shot does not exist.'),
    ])
    const result = await turn(projectId, gateway, 'redo shot 9')
    expect(result.ok).toBe(true)
    expect((await usageRows(projectId)).filter((r) => r.operation === 'write_image_prompts')).toEqual([])
  })

  test('an over-long instruction is sent back to the model to shorten, with no call, claim or charge', async () => {
    const projectId = await seedProject()
    await seedShots(projectId, 1)
    const gateway = scriptedGateway([
      successMessage({ shot_number: 1, instruction: 'x'.repeat(IMAGE_PROMPTS_INSTRUCTION_MAX_CHARS + 1) }, 'regenerate_image_prompt'),
      textMessage('Could you shorten that?'),
    ])
    const result = await turn(projectId, gateway, 'redo shot 1 with a very long note')
    expect(result.ok).toBe(true)
    expect(gateway.getCallCount()).toBe(2)
    expect((await usageRows(projectId)).filter((r) => r.operation === 'write_image_prompts')).toEqual([])
    expect((await messageRows(projectId)).filter((m) => m.kind === 'tool_done' || m.kind === 'refusal')).toEqual([])
  })
})

test.describe('runAgentTurn - Step 3 tool_started (card locking)', () => {
  type Ev = { type: string; scope?: unknown; toolName?: string }
  const collect = () => {
    const events: Ev[] = []
    return { events, onEvent: (e: Ev) => events.push(e) }
  }

  test('a single-shot regeneration announces its shot BEFORE the paid call and before tool_completed', async () => {
    const projectId = await seedProject()
    const shots = await seedShots(projectId, 2)
    const { events, onEvent } = collect()
    const seenAtNestedCall: string[] = []
    const gateway = scriptedGateway([
      successMessage({ shot_number: 2 }, 'regenerate_image_prompt'),
      successMessage({ prompts: [{ shot_key: shots[1].shot_key, image_prompt: GOOD_PROMPT }] }, 'write_image_prompts'),
      textMessage('Done.'),
    ])
    // Record what the client had been told by the time the nested (paid) call is made.
    const original = gateway.createMessage.bind(gateway)
    let call = 0
    gateway.createMessage = async (params, hooks) => {
      call++
      if (call === 2) seenAtNestedCall.push(...events.map((e) => e.type))
      return original(params, hooks)
    }

    await turn(projectId, gateway, 'redo shot 2', { onEvent })

    expect(seenAtNestedCall).toContain('tool_started')
    const types = events.map((e) => e.type)
    expect(types.indexOf('tool_started')).toBeLessThan(types.indexOf('tool_completed'))
    expect(events.find((e) => e.type === 'tool_started')!.scope).toEqual({ shotNumber: 2 })
  })

  test('regenerate-all announces the whole list', async () => {
    const projectId = await seedProject()
    const shots = await seedShots(projectId, 2)
    const { events, onEvent } = collect()
    const gateway = scriptedGateway([
      successMessage({}, 'regenerate_all_image_prompts'),
      successMessage({ prompts: shots.map((s) => ({ shot_key: s.shot_key, image_prompt: GOOD_PROMPT })) }, 'write_image_prompts'),
      textMessage('Done.'),
    ])
    await turn(projectId, gateway, 'redo them all', { onEvent })
    expect(events.filter((e) => e.type === 'tool_started').map((e) => e.scope)).toEqual(['all'])
  })

  test('decline, a chat-only turn and an unusable shot number announce nothing', async () => {
    const projectId = await seedProject()
    await seedShots(projectId, 1)
    const { events, onEvent } = collect()
    const gateway = scriptedGateway([
      successMessage({ message: 'I cannot edit prompt text directly.' }, 'decline'),
      successMessage({ shot_number: 0 }, 'regenerate_image_prompt'),
      textMessage('Use the prompt box to edit text.'),
    ])
    await turn(projectId, gateway, 'edit the prompt text', { onEvent })
    expect(events.some((e) => e.type === 'tool_started')).toBe(false)
  })

  test('the Workbench never announces a tool start - its cards lock on completion, as before', async () => {
    const projectId = await seedProject({ current_step: 'workbench', furthest_step: 2 })
    const { data: shot } = await admin
      .from('shots')
      .insert({ project_id: projectId, order_index: 0, shot_key: 'wbk01', voice_over: 'Old.', visual_description: 'Old.' })
      .select('id')
      .single()
    expect(shot).not.toBeNull()
    const { events, onEvent } = collect()
    const gateway = scriptedGateway([
      successMessage({ shot_number: 1, voice_over: 'New.' }, 'update_shot'),
      textMessage('Done.'),
    ])
    await runAgentTurn({
      config: getAgentStepConfig('workbench'),
      gateway,
      supabase: admin,
      projectId,
      userId: primary.user.id,
      content: 'change shot 1',
      clientId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      recordTurnSpend: async () => {},
      onEvent,
    })
    expect(events.some((e) => e.type === 'tool_completed')).toBe(true)
    expect(events.some((e) => e.type === 'tool_started')).toBe(false)
  })
})

test.describe('runAgentTurn - Step 3 balance gate', () => {
  test('a turn refused for insufficient balance spends nothing, calls no model, and leaves no generations, usage or ledger row', async () => {
    const projectId = await seedProject()
    await seedShots(projectId, 3)
    const gateway = scriptedGateway([])

    const result = await turn(projectId, gateway, 'rewrite every prompt', { getBalance: async () => 0 })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(402)
    expect(gateway.getCallCount()).toBe(0)
    expect(await generationRows(projectId)).toEqual([])
    expect(await usageRows(projectId)).toEqual([])
    expect(await ledgerRows(projectId)).toEqual([])

    // The exchange itself is still recorded, so a resend of this message resolves
    // instead of looping: the user's message and a plain assistant reply.
    const messages = await messageRows(projectId)
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(messages[1].content).toMatch(/credits/i)
  })

  test("the gate reads the user's own balance once, before any model call", async () => {
    const projectId = await seedProject()
    await seedShots(projectId, 3)
    let seenBalanceFor = 0
    const gateway = scriptedGateway([])
    // 1 credit is below any realistic estimate for a turn with a tool call.
    const result = await turn(projectId, gateway, 'rewrite every prompt', {
      getBalance: async (userId: string) => {
        seenBalanceFor++
        expect(userId).toBe(primary.user.id)
        return 1
      },
    })
    expect(result.ok).toBe(false)
    expect(seenBalanceFor).toBe(1)
    expect(gateway.getCallCount()).toBe(0)
  })

  // The gate's figure is an estimate of a real turn (up to three agent calls plus the
  // largest tool call at its expected size), not the per-call max_tokens ceiling - which,
  // at ~90 credits for a 3-shot project on the dev model, refused turns that cost ~5.
  test('a balance that covers a realistic turn is not refused (the old ceiling quote would have refused it)', async () => {
    const projectId = await seedProject()
    await seedShots(projectId, 3)
    const gateway = scriptedGateway([textMessage('Which shot did you mean?')])
    const result = await turn(projectId, gateway, 'make it colder', { getBalance: async () => 60 })
    expect(result.ok).toBe(true)
    expect(gateway.getCallCount()).toBe(1)
  })

  test('a balance below the estimate is refused, and the message names both figures', async () => {
    const projectId = await seedProject()
    await seedShots(projectId, 3)
    const gateway = scriptedGateway([])
    const result = await turn(projectId, gateway, 'make it colder', { getBalance: async () => 5 })
    expect(result.ok).toBe(false)
    const reply = (await messageRows(projectId)).find((m) => m.role === 'assistant')!
    expect(reply.content).toMatch(/\b5\b/)
    expect(reply.content).toMatch(/credits/i)
  })

  test('the Workbench config is never balance-gated', async () => {
    const projectId = await seedProject({ current_step: 'workbench', furthest_step: 2 })
    const gateway = scriptedGateway([textMessage('Hi.')])
    const result = await runAgentTurn({
      config: getAgentStepConfig('workbench'),
      gateway,
      supabase: admin,
      projectId,
      userId: primary.user.id,
      content: 'hello',
      clientId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      recordTurnSpend: async () => {},
      getBalance: async () => {
        throw new Error('the Workbench must not check balance')
      },
    })
    expect(result.ok).toBe(true)
  })

  test('a project past the storyboard still runs Step 3 turns: no lock, the model is called, the balance gate applies', async () => {
    const projectId = await seedProject({ furthest_step: 4 })
    await seedShots(projectId, 1)
    expect(getAgentStepConfig('image_prompts').lock).toBeUndefined()

    const gateway = scriptedGateway([textMessage('Which shot did you mean?')])
    const result = await turn(projectId, gateway, 'make it colder')
    expect(result.ok).toBe(true)
    expect(gateway.getCallCount()).toBe(1)
    const reply = (await messageRows(projectId)).find((m) => m.role === 'assistant')!
    expect(reply.content).not.toMatch(/locked/i)

    const refused = await turn(projectId, scriptedGateway([]), 'make it colder', { getBalance: async () => 0 })
    expect(refused.ok).toBe(false)
  })
})

test.describe('runAgentTurn - Step 3 stored payload', () => {
  async function seedFailedRowWithPayload(projectId: string, shotKeys: string[]) {
    const { error } = await admin.from('generations').insert({
      project_id: projectId,
      step: 'image_prompts',
      operation: 'write_image_prompts',
      shot_id: null,
      state: 'failed',
      payload: { prompts: shotKeys.map((shot_key) => ({ shot_key, image_prompt: GOOD_PROMPT })) },
    })
    expect(error).toBeNull()
  }

  test('an instruction with a covering paid payload defers: no generation, no spend, nothing written, the model is told to ask', async () => {
    const projectId = await seedProject()
    const shots = await seedShots(projectId, 1)
    await seedFailedRowWithPayload(projectId, [shots[0].shot_key])

    const gateway = scriptedGateway([
      successMessage({ shot_number: 1, instruction: 'make it colder' }, 'regenerate_image_prompt'),
      textMessage('There is an unapplied result from earlier - should I use it, or write a fresh one with your note?'),
    ])
    const result = await turn(projectId, gateway, 'make shot 1 colder')
    expect(result.ok).toBe(true)
    expect(gateway.getCallCount()).toBe(2)

    // The tool result the model saw says a paid result exists and the instruction was NOT applied.
    // params.messages is the live array the turn keeps appending to, so find the
    // tool_result block rather than assuming it is last.
    const toolResult = (gateway.getCalls()[1].messages as { role: string; content: unknown }[]).find(
      (m) => m.role === 'user' && Array.isArray(m.content) && JSON.stringify(m.content).includes('tool_result')
    )!
    const text = JSON.stringify(toolResult.content)
    expect(text).toMatch(/not been applied/i)
    expect(text).toMatch(/ask the user/i)

    expect((await usageRows(projectId)).filter((r) => r.operation === 'write_image_prompts')).toEqual([])
    const { data: gen } = await admin
      .from('generations')
      .select('state, payload')
      .eq('project_id', projectId)
      .eq('operation', 'write_image_prompts')
      .single()
    expect(gen!.state).toBe('failed')
    expect(gen!.payload).not.toBeNull()
    const { data: shot } = await admin.from('shots').select('image_prompt').eq('id', shots[0].id).single()
    expect(shot!.image_prompt).toBe('An older prompt that will be replaced.')
    // A deferral is not a tool_done, a refusal or an error.
    expect((await messageRows(projectId)).filter((m) => m.kind !== 'text')).toEqual([])
  })

  test("stored_result 'use' lands the paid payload for free, without a nested call or the instruction", async () => {
    const projectId = await seedProject()
    const shots = await seedShots(projectId, 1)
    await seedFailedRowWithPayload(projectId, [shots[0].shot_key])

    const gateway = scriptedGateway([
      successMessage({ shot_number: 1, instruction: 'make it colder', stored_result: 'use' }, 'regenerate_image_prompt'),
      textMessage('Used the earlier result.'),
    ])
    expect((await turn(projectId, gateway, 'yes, use the earlier one')).ok).toBe(true)
    expect(gateway.getCallCount()).toBe(2)
    expect((await usageRows(projectId)).filter((r) => r.operation === 'write_image_prompts')).toEqual([])
    const { data: shot } = await admin.from('shots').select('image_prompt').eq('id', shots[0].id).single()
    expect(shot!.image_prompt).toBe(GOOD_PROMPT)
  })

  test("stored_result 'fresh' makes a new call that carries the instruction", async () => {
    const projectId = await seedProject()
    const shots = await seedShots(projectId, 1)
    await seedFailedRowWithPayload(projectId, [shots[0].shot_key])

    const gateway = scriptedGateway([
      successMessage({ shot_number: 1, instruction: 'make it colder', stored_result: 'fresh' }, 'regenerate_image_prompt'),
      successMessage(
        { prompts: [{ shot_key: shots[0].shot_key, image_prompt: `${GOOD_PROMPT} Colder still.` }] },
        'write_image_prompts'
      ),
      textMessage('Wrote a fresh one.'),
    ])
    expect((await turn(projectId, gateway, 'no, write a fresh one')).ok).toBe(true)
    expect(gateway.getCallCount()).toBe(3)
    expect(userMessageOfCall(gateway.getCalls()[1])).toContain('make it colder')
    const { data: shot } = await admin.from('shots').select('image_prompt').eq('id', shots[0].id).single()
    expect(shot!.image_prompt).toContain('Colder still.')
  })

  test('with no instruction a covering payload is simply recovered, exactly as the button does', async () => {
    const projectId = await seedProject()
    const shots = await seedShots(projectId, 1)
    await seedFailedRowWithPayload(projectId, [shots[0].shot_key])
    const gateway = scriptedGateway([
      successMessage({ shot_number: 1 }, 'regenerate_image_prompt'),
      textMessage('Done.'),
    ])
    expect((await turn(projectId, gateway, 'redo shot 1')).ok).toBe(true)
    expect(gateway.getCallCount()).toBe(2)
    const { data: shot } = await admin.from('shots').select('image_prompt').eq('id', shots[0].id).single()
    expect(shot!.image_prompt).toBe(GOOD_PROMPT)
  })
})

test.describe('runAgentTurn - Step 3 while another run holds the generation slot', () => {
  const COVERING = (keys: string[]) => ({ prompts: keys.map((shot_key) => ({ shot_key, image_prompt: GOOD_PROMPT })) })

  async function seedGenerating(projectId: string, keys: string[], startedAgoMs: number) {
    const { error } = await admin.from('generations').insert({
      project_id: projectId,
      step: 'image_prompts',
      operation: 'write_image_prompts',
      shot_id: null,
      state: 'generating',
      // Another tab's run, between saving the model's answer and finishing its writes.
      payload: COVERING(keys),
      started_at: new Date(Date.now() - startedAgoMs).toISOString(),
    })
    expect(error).toBeNull()
  }

  // A second tab's request while the first is in flight must be REJECTED by the slot's
  // lock, not answered with a question about a result that is about to land by itself.
  for (const storedResult of [undefined, 'use', 'fresh'] as const) {
    test(`a live run holds the slot: a request ${storedResult ? `answering stored_result '${storedResult}'` : 'with an instruction'} is refused as in progress, spends nothing, and leaves the run untouched`, async () => {
      const projectId = await seedProject()
      const shots = await seedShots(projectId, 1)
      await seedGenerating(projectId, [shots[0].shot_key], 30_000)

      const input = { shot_number: 1, instruction: 'make it colder', ...(storedResult ? { stored_result: storedResult } : {}) }
      const gateway = scriptedGateway([
        successMessage(input, 'regenerate_image_prompt'),
        textMessage('Another generation is already running - try again in a moment.'),
      ])
      const result = await turn(projectId, gateway, 'make shot 1 colder')
      expect(result.ok).toBe(true)

      // The tool answered with the lock's rejection, never the stored-result question.
      const toolResult = (gateway.getCalls()[1].messages as { role: string; content: unknown }[]).find(
        (m) => m.role === 'user' && Array.isArray(m.content) && JSON.stringify(m.content).includes('tool_result')
      )!
      const text = JSON.stringify(toolResult.content)
      expect(text).toMatch(/already in progress/i)
      expect(text).not.toMatch(/stored_result_available/)

      // A refusal row was persisted; nothing was spent; the other run's row is untouched.
      expect((await messageRows(projectId)).filter((m) => m.kind === 'refusal').length).toBe(1)
      expect((await usageRows(projectId)).filter((r) => r.operation === 'write_image_prompts')).toEqual([])
      const { data: gen } = await admin
        .from('generations')
        .select('state, payload')
        .eq('project_id', projectId)
        .eq('operation', 'write_image_prompts')
        .single()
      expect(gen!.state).toBe('generating')
      expect(gen!.payload).not.toBeNull()
      const { data: shot } = await admin.from('shots').select('image_prompt').eq('id', shots[0].id).single()
      expect(shot!.image_prompt).toBe('An older prompt that will be replaced.')
    })
  }

  test('a run that died mid-flight (past the stale window) still holds a paid payload, so the question is asked', async () => {
    const projectId = await seedProject()
    const shots = await seedShots(projectId, 1)
    // Older than the operation's stale window (15 min): reclaimable, and its payload is paid for.
    await seedGenerating(projectId, [shots[0].shot_key], 16 * 60 * 1000)

    const gateway = scriptedGateway([
      successMessage({ shot_number: 1, instruction: 'make it colder' }, 'regenerate_image_prompt'),
      textMessage('There is an earlier unapplied result - use it?'),
    ])
    expect((await turn(projectId, gateway, 'make shot 1 colder')).ok).toBe(true)
    const toolResult = (gateway.getCalls()[1].messages as { role: string; content: unknown }[]).find(
      (m) => m.role === 'user' && Array.isArray(m.content) && JSON.stringify(m.content).includes('tool_result')
    )!
    expect(JSON.stringify(toolResult.content)).toMatch(/stored_result_available/)
  })
})

test.describe('runAgentTurn - Step 3 history keeps what the model already answered', () => {
  // Same shared history query as the Workbench (its fix: a refusal is a real answer, so it
  // must stay in history or a later turn re-answers the declined request). Pinned here for
  // Step 3's own config, whose decline goes through the same path.
  test('a declined request and its reply stay in the next turn\'s history; tool_done activity does not', async () => {
    const projectId = await seedProject()
    const shots = await seedShots(projectId, 1)

    const first = scriptedGateway([
      successMessage({ message: 'I cannot edit prompt text directly - use the prompt box.' }, 'decline'),
      successMessage({ shot_number: 1 }, 'regenerate_image_prompt'),
      successMessage({ prompts: [{ shot_key: shots[0].shot_key, image_prompt: GOOD_PROMPT }] }, 'write_image_prompts'),
      textMessage('Declined the edit and rewrote shot 1.'),
    ])
    expect((await turn(projectId, first, 'set shot 1 to "a red door", and redo it')).ok).toBe(true)

    const second = scriptedGateway([textMessage('Anything else?')])
    expect((await turn(projectId, second, 'thanks')).ok).toBe(true)
    const seen = (second.getCalls()[0].messages as { role: string; content: unknown }[])
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('\n')
    expect(seen).toContain('set shot 1 to "a red door", and redo it')
    expect(seen).toContain('I cannot edit prompt text directly')
    expect(seen).not.toContain('Rewrote Shot 1 prompt')
  })
})
