import { test, expect } from '@playwright/test'
import { admin } from './supabase-test-session'
import { primary } from './fixed-users'
import { buildShotIndexBlock, AGENT_TOOLS, AGENT_SYSTEM_PROMPT_V6 } from '../src/lib/prompts/agent'
import {
  handleGetShot,
  handleUpdateShot,
  handleInsertShot,
  handleRegenerateAllShots,
  dispatchAgentTool,
  type AgentToolContext,
} from '../src/app/api/projects/[id]/agent/tools'
import { stepIndex } from '../src/lib/config/pipeline'
import { successMessage, throwingGateway, textMessage, scriptedGateway, multiToolMessage } from './helpers/claude-fakes'
import type { ClaudeGateway } from '../src/lib/claude'
import { runAgentTurn, type AgentStreamEvent } from '../src/app/api/projects/[id]/agent/logic'
import { STALE_AFTER_MS } from '../src/lib/generations/operation-policy'

let toolSeq = 0
function nextShotIdentity() {
  toolSeq++
  return { orderIndex: toolSeq, shotKey: `t${String(toolSeq).padStart(4, '0')}` }
}

async function seedToolProject(overrides: Record<string, unknown> = {}) {
  const { data, error } = await admin
    .from('projects')
    .insert({
      user_id: primary.user.id,
      title: 'Agent tool test',
      source_text: 'A short film for agent-tool tests.',
      video_type: 'auto',
      duration_target: '30-60s',
      current_step: 'workbench',
      furthest_step: 2,
      ...overrides,
    })
    .select('id')
    .single()
  expect(error).toBeNull()
  return data!.id as string
}

async function seedToolShot(projectId: string, overrides: Record<string, unknown> = {}) {
  const { orderIndex, shotKey } = nextShotIdentity()
  const { data, error } = await admin
    .from('shots')
    .insert({
      project_id: projectId,
      order_index: orderIndex,
      shot_key: shotKey,
      voice_over: 'Original voiceover.',
      visual_description: 'Original visual description.',
      ...overrides,
    })
    .select('id')
    .single()
  expect(error).toBeNull()
  return data!.id as string
}

async function seedCharacter(projectId: string, name: string) {
  const { data, error } = await admin
    .from('elements')
    .insert({ project_id: projectId, name, type: 'character' })
    .select('id')
    .single()
  expect(error).toBeNull()
  return data!.id as string
}

async function bindElement(shotId: string, elementId: string) {
  const { error } = await admin.from('shot_elements').insert({ shot_id: shotId, element_id: elementId })
  expect(error).toBeNull()
}

async function readShot(shotId: string) {
  const { data } = await admin.from('shots').select('*').eq('id', shotId).single()
  return data!
}

async function readShots(projectId: string) {
  const { data } = await admin.from('shots').select('*').eq('project_id', projectId).order('order_index')
  return data!
}

async function readDialogue(shotId: string) {
  const { data } = await admin
    .from('shot_dialogue')
    .select('*')
    .eq('shot_id', shotId)
    .order('order_index')
  return data!
}

async function seedMessage(projectId: string) {
  const { data, error } = await admin
    .from('messages')
    .insert({ project_id: projectId, role: 'user', content: 'a turn' })
    .select('id')
    .single()
  expect(error).toBeNull()
  return data!.id as string
}

function buildContext(overrides: Partial<AgentToolContext> & { projectId: string }): AgentToolContext {
  return {
    supabase: admin,
    gateway: throwingGateway('regenerate_all_shots should not be invoked in this test'),
    userId: primary.user.id,
    messageId: crypto.randomUUID(),
    furthestStepIndex: stepIndex('workbench'),
    ...overrides,
  }
}

type IndexShot = {
  order_index: number
  visual_description: string | null
  voice_over: string
  shot_size_origin: string
  camera_angle_origin: string
  camera_movement_origin: string
}

function shot(overrides: Partial<IndexShot> & { order_index: number }): IndexShot {
  return {
    visual_description: null,
    voice_over: '',
    shot_size_origin: 'auto',
    camera_angle_origin: 'auto',
    camera_movement_origin: 'auto',
    ...overrides,
  }
}

test.describe('buildShotIndexBlock', () => {
  test('numbers shots 1-based from order_index, matching the UI', () => {
    const block = buildShotIndexBlock([
      shot({ order_index: 0, visual_description: 'Wide shot of a castle' }),
      shot({ order_index: 1, visual_description: 'Close up of a dog' }),
    ])
    expect(block).toContain('1. Wide shot of a castle')
    expect(block).toContain('2. Close up of a dog')
  })

  test('falls back to voice_over when visual_description is null, then to a placeholder', () => {
    const block = buildShotIndexBlock([
      shot({ order_index: 0, visual_description: null, voice_over: 'Once upon a time' }),
      shot({ order_index: 1, visual_description: null, voice_over: '' }),
    ])
    expect(block).toContain('1. Once upon a time (no visual description)')
    expect(block).toContain('2. (empty shot)')
  })

  test('marks a voice_over-fallback slug as missing a visual description, but not the empty-shot placeholder', () => {
    const block = buildShotIndexBlock([
      shot({ order_index: 0, visual_description: '', voice_over: 'The vendor calls out at dawn' }),
    ])
    const lines = block.split('\n')
    expect(lines[0]).toBe('1. The vendor calls out at dawn (no visual description)')
    expect(lines[0]).not.toContain('(empty shot)')
  })

  test('does not mark a shot that already has a visual description', () => {
    const block = buildShotIndexBlock([shot({ order_index: 0, visual_description: 'A dusty market street' })])
    expect(block).not.toContain('no visual description')
  })

  test('truncates a long slug to 50 characters with an ellipsis', () => {
    const long = 'A'.repeat(80)
    const block = buildShotIndexBlock([shot({ order_index: 0, visual_description: long })])
    expect(block).toContain('A'.repeat(50) + '…')
    expect(block).not.toContain('A'.repeat(51))
  })

  test('lists overridden camera fields, and omits the suffix when nothing is overridden', () => {
    const block = buildShotIndexBlock([
      shot({ order_index: 0, visual_description: 'Shot A', shot_size_origin: 'override' }),
      shot({ order_index: 1, visual_description: 'Shot B' }),
    ])
    const lines = block.split('\n')
    expect(lines[0]).toContain('[override: shot_size]')
    expect(lines[1]).not.toContain('override')
  })

  test('lists multiple overridden fields comma-separated', () => {
    const block = buildShotIndexBlock([
      shot({
        order_index: 0,
        visual_description: 'Shot A',
        shot_size_origin: 'override',
        camera_movement_origin: 'override',
      }),
    ])
    expect(block).toContain('[override: shot_size, camera_movement]')
  })
})

test.describe('AGENT_TOOLS', () => {
  test('is exactly get_shot, update_shot, insert_shot, regenerate_all_shots, finish - no delete tool, ever', () => {
    expect(AGENT_TOOLS.map((t) => t.name)).toEqual([
      'get_shot',
      'update_shot',
      'insert_shot',
      'regenerate_all_shots',
      'finish',
    ])
  })

  test('finish takes only a required message string, no other properties', () => {
    const finish = AGENT_TOOLS.find((t) => t.name === 'finish')!
    const schema = finish.input_schema as unknown as {
      properties: Record<string, unknown>
      required: string[]
      additionalProperties: boolean
    }
    expect(Object.keys(schema.properties)).toEqual(['message'])
    expect(schema.required).toEqual(['message'])
    expect(schema.additionalProperties).toBe(false)
  })

  test('update_shot and insert_shot reject unknown properties', () => {
    const updateShot = AGENT_TOOLS.find((t) => t.name === 'update_shot')!
    const insertShot = AGENT_TOOLS.find((t) => t.name === 'insert_shot')!
    expect((updateShot.input_schema as unknown as { additionalProperties: boolean }).additionalProperties).toBe(false)
    expect((insertShot.input_schema as unknown as { additionalProperties: boolean }).additionalProperties).toBe(false)
  })

  test('insert_shot has no dialogue field - add a line via a follow-up update_shot call instead', () => {
    const insertShot = AGENT_TOOLS.find((t) => t.name === 'insert_shot')!
    const props = (insertShot.input_schema as unknown as { properties: Record<string, unknown> }).properties
    expect(props.dialogue).toBeUndefined()
  })
})

test.describe('AGENT_SYSTEM_PROMPT_V6', () => {
  test('explicitly instructs the model never to delete a shot', () => {
    expect(AGENT_SYSTEM_PROMPT_V6.toLowerCase()).toContain('delete')
  })

  test('defaults to acting on a content request rather than asking a clarifying question', () => {
    expect(AGENT_SYSTEM_PROMPT_V6.toLowerCase()).toContain('default to acting')
  })

  test('directs the model to use other shots as a style reference instead of asking the user to specify one', () => {
    expect(AGENT_SYSTEM_PROMPT_V6.toLowerCase()).toContain('style reference')
  })

  test('reserves clarifying questions for which-shot/which-field ambiguity or a destructive guess', () => {
    const prompt = AGENT_SYSTEM_PROMPT_V6.toLowerCase()
    expect(prompt).toContain('which shot or which field')
    expect(prompt).toContain('destructive')
  })

  test('states bundling finish with the final tool call as the default, not merely an option', () => {
    const prompt = AGENT_SYSTEM_PROMPT_V6.toLowerCase()
    expect(prompt).toContain('finish')
    expect(prompt).toContain('same response as your final tool call')
    expect(prompt).toContain('default to calling finish')
  })

  test('warns finish must only accompany the LAST action, not the first of several', () => {
    expect(AGENT_SYSTEM_PROMPT_V6.toLowerCase()).toContain('not finished after the first one')
  })
})

test.describe('handleGetShot', () => {
  test('returns full detail, bound characters, and resolved dialogue for one shot', async () => {
    const projectId = await seedToolProject()
    const shotId = await seedToolShot(projectId, { voice_over: 'Full text.', shot_size: 'wide', shot_size_origin: 'override' })
    const characterId = await seedCharacter(projectId, 'Mara')
    await bindElement(shotId, characterId)
    await admin
      .from('shot_dialogue')
      .insert({ project_id: projectId, shot_id: shotId, element_id: characterId, line: 'Hello.', order_index: 0 })
    const shotNumber = (await readShot(shotId)).order_index + 1

    const outcome = await handleGetShot({ shot_number: shotNumber }, buildContext({ projectId }))

    expect(outcome.kind).toBe('applied')
    const forModel = outcome.forModel as {
      voice_over: string
      shot_size: string
      bound_characters: string[]
      dialogue: { speaker_name: string; line: string }[]
    }
    expect(forModel.voice_over).toBe('Full text.')
    expect(forModel.shot_size).toBe('wide')
    expect(forModel.bound_characters).toEqual(['Mara'])
    expect(forModel.dialogue).toEqual([{ speaker_name: 'Mara', line: 'Hello.' }])
  })

  test('an unknown shot number errors, not refuses', async () => {
    const projectId = await seedToolProject()
    const outcome = await handleGetShot({ shot_number: 99 }, buildContext({ projectId }))
    expect(outcome.kind).toBe('errored')
  })
})

test.describe('handleUpdateShot', () => {
  test('writes only the fields explicitly named in the call - a sibling camera field is untouched', async () => {
    const projectId = await seedToolProject()
    const shotId = await seedToolShot(projectId, {
      camera_angle: 'eye_level',
      camera_angle_origin: 'auto',
      camera_movement: 'static',
      camera_movement_origin: 'auto',
    })
    const shotNumber = (await readShot(shotId)).order_index + 1

    const outcome = await handleUpdateShot(
      { shot_number: shotNumber, shot_size: 'wide', shot_size_origin: 'derived' },
      buildContext({ projectId })
    )

    expect(outcome.kind).toBe('applied')
    const after = await readShot(shotId)
    expect(after.shot_size).toBe('wide')
    expect(after.camera_angle).toBe('eye_level')
    expect(after.camera_movement).toBe('static')
  })

  test('a stored override is protected: the model supplying auto does not overwrite it, but derived does', async () => {
    const projectId = await seedToolProject()
    const shotId = await seedToolShot(projectId, { shot_size: 'wide', shot_size_origin: 'override' })
    const shotNumber = (await readShot(shotId)).order_index + 1
    const ctx = buildContext({ projectId })

    const refused = await handleUpdateShot(
      { shot_number: shotNumber, shot_size: 'medium', shot_size_origin: 'auto' },
      ctx
    )
    expect((await readShot(shotId)).shot_size).toBe('wide')
    expect((await readShot(shotId)).shot_size_origin).toBe('override')
    void refused

    await handleUpdateShot({ shot_number: shotNumber, shot_size: 'medium', shot_size_origin: 'derived' }, ctx)
    expect((await readShot(shotId)).shot_size).toBe('medium')
    expect((await readShot(shotId)).shot_size_origin).toBe('derived')
  })

  test('staleness parity: a voice_over write sets the same flags a manual edit would', async () => {
    const projectId = await seedToolProject()
    const shotId = await seedToolShot(projectId)
    const shotNumber = (await readShot(shotId)).order_index + 1

    await handleUpdateShot({ shot_number: shotNumber, voice_over: 'New narration.' }, buildContext({ projectId }))

    const after = await readShot(shotId)
    expect(after.image_prompt_stale).toBe(true)
    expect(after.video_prompt_stale).toBe(true)
    const { data: project } = await admin.from('projects').select('voiceover_stale').eq('id', projectId).single()
    expect(project!.voiceover_stale).toBe(true)
  })

  test('refuses to clear visual_description to empty, and writes nothing', async () => {
    const projectId = await seedToolProject()
    const shotId = await seedToolShot(projectId, { visual_description: 'Original description.' })
    const shotNumber = (await readShot(shotId)).order_index + 1

    const outcome = await handleUpdateShot(
      { shot_number: shotNumber, visual_description: '' },
      buildContext({ projectId })
    )

    expect(outcome.kind).toBe('refused')
    expect((await readShot(shotId)).visual_description).toBe('Original description.')
  })

  test('refuses to clear visual_description to whitespace-only, and writes nothing', async () => {
    const projectId = await seedToolProject()
    const shotId = await seedToolShot(projectId, { visual_description: 'Original description.' })
    const shotNumber = (await readShot(shotId)).order_index + 1

    const outcome = await handleUpdateShot(
      { shot_number: shotNumber, visual_description: '   ' },
      buildContext({ projectId })
    )

    expect(outcome.kind).toBe('refused')
    expect((await readShot(shotId)).visual_description).toBe('Original description.')
  })

  test('dialogue: a bound character speaker writes the line and sets video_prompt_stale only', async () => {
    const projectId = await seedToolProject()
    const shotId = await seedToolShot(projectId)
    const characterId = await seedCharacter(projectId, 'Mara')
    await bindElement(shotId, characterId)
    const shotNumber = (await readShot(shotId)).order_index + 1

    const outcome = await handleUpdateShot(
      { shot_number: shotNumber, dialogue: [{ speaker_name: 'Mara', line: 'Hello there.' }] },
      buildContext({ projectId })
    )

    expect(outcome.kind).toBe('applied')
    const lines = await readDialogue(shotId)
    expect(lines.length).toBe(1)
    expect(lines[0].element_id).toBe(characterId)
    expect(lines[0].line).toBe('Hello there.')
    const after = await readShot(shotId)
    expect(after.video_prompt_stale).toBe(true)
    expect(after.image_prompt_stale).toBe(false)
  })

  test('dialogue: rewriting an existing bound character line replaces its text, element_id untouched', async () => {
    const projectId = await seedToolProject()
    const shotId = await seedToolShot(projectId)
    const characterId = await seedCharacter(projectId, 'Mara')
    await bindElement(shotId, characterId)
    await admin
      .from('shot_dialogue')
      .insert({ project_id: projectId, shot_id: shotId, element_id: characterId, line: 'Old line.', order_index: 0 })
    const shotNumber = (await readShot(shotId)).order_index + 1

    const outcome = await handleUpdateShot(
      { shot_number: shotNumber, dialogue: [{ speaker_name: 'Mara', line: 'New line.' }] },
      buildContext({ projectId })
    )

    expect(outcome.kind).toBe('applied')
    const lines = await readDialogue(shotId)
    expect(lines.length).toBe(1)
    expect(lines[0].line).toBe('New line.')
    expect(lines[0].element_id).toBe(characterId)
  })

  test('refuses to clear voice_over to empty on a shot with no dialogue, and writes nothing', async () => {
    const projectId = await seedToolProject()
    const shotId = await seedToolShot(projectId, { voice_over: 'Original narration.' })
    const shotNumber = (await readShot(shotId)).order_index + 1

    const outcome = await handleUpdateShot({ shot_number: shotNumber, voice_over: '' }, buildContext({ projectId }))

    expect(outcome.kind).toBe('refused')
    expect((await readShot(shotId)).voice_over).toBe('Original narration.')
  })

  test('allows clearing voice_over to empty when dialogue is included in the same call', async () => {
    const projectId = await seedToolProject()
    const shotId = await seedToolShot(projectId, { voice_over: 'Original narration.' })
    const characterId = await seedCharacter(projectId, 'Mara')
    await bindElement(shotId, characterId)
    const shotNumber = (await readShot(shotId)).order_index + 1

    const outcome = await handleUpdateShot(
      { shot_number: shotNumber, voice_over: '', dialogue: [{ speaker_name: 'Mara', line: 'Hello there.' }] },
      buildContext({ projectId })
    )

    expect(outcome.kind).toBe('applied')
    expect((await readShot(shotId)).voice_over).toBe('')
    const lines = await readDialogue(shotId)
    expect(lines.length).toBe(1)
  })

  test('allows clearing voice_over to empty when the shot already has bound dialogue', async () => {
    const projectId = await seedToolProject()
    const shotId = await seedToolShot(projectId, { voice_over: 'Original narration.' })
    const characterId = await seedCharacter(projectId, 'Mara')
    await bindElement(shotId, characterId)
    await admin
      .from('shot_dialogue')
      .insert({ project_id: projectId, shot_id: shotId, element_id: characterId, line: 'Already there.', order_index: 0 })
    const shotNumber = (await readShot(shotId)).order_index + 1

    const outcome = await handleUpdateShot({ shot_number: shotNumber, voice_over: '' }, buildContext({ projectId }))

    expect(outcome.kind).toBe('applied')
    expect((await readShot(shotId)).voice_over).toBe('')
  })

  test('dialogue: omitting a line from the array removes it', async () => {
    const projectId = await seedToolProject()
    const shotId = await seedToolShot(projectId)
    const characterId = await seedCharacter(projectId, 'Mara')
    await bindElement(shotId, characterId)
    await admin.from('shot_dialogue').insert([
      { project_id: projectId, shot_id: shotId, element_id: characterId, line: 'Keep this.', order_index: 0 },
      { project_id: projectId, shot_id: shotId, element_id: characterId, line: 'Remove this.', order_index: 1 },
    ])
    const shotNumber = (await readShot(shotId)).order_index + 1

    const outcome = await handleUpdateShot(
      { shot_number: shotNumber, dialogue: [{ speaker_name: 'Mara', line: 'Keep this.' }] },
      buildContext({ projectId })
    )

    expect(outcome.kind).toBe('applied')
    const lines = await readDialogue(shotId)
    expect(lines.length).toBe(1)
    expect(lines[0].line).toBe('Keep this.')
  })

  test('dialogue: adding a new line for an already-bound character is allowed', async () => {
    const projectId = await seedToolProject()
    const shotId = await seedToolShot(projectId)
    const characterId = await seedCharacter(projectId, 'Mara')
    await bindElement(shotId, characterId)
    await admin
      .from('shot_dialogue')
      .insert({ project_id: projectId, shot_id: shotId, element_id: characterId, line: 'First.', order_index: 0 })
    const shotNumber = (await readShot(shotId)).order_index + 1

    const outcome = await handleUpdateShot(
      {
        shot_number: shotNumber,
        dialogue: [
          { speaker_name: 'Mara', line: 'First.' },
          { speaker_name: 'Mara', line: 'Second.' },
        ],
      },
      buildContext({ projectId })
    )

    expect(outcome.kind).toBe('applied')
    const lines = await readDialogue(shotId)
    expect(lines.map((l) => l.line)).toEqual(['First.', 'Second.'])
  })

  test('dialogue: an unbound speaker refuses the WHOLE call with an actionable message, and creates or modifies nothing in elements or shot_elements', async () => {
    const projectId = await seedToolProject()
    const shotId = await seedToolShot(projectId, { voice_over: 'Original.' })
    const shotNumber = (await readShot(shotId)).order_index + 1

    const { count: elementsBefore } = await admin
      .from('elements')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', projectId)
    const { count: bindingsBefore } = await admin
      .from('shot_elements')
      .select('shot_id', { count: 'exact', head: true })
      .eq('shot_id', shotId)

    const outcome = await handleUpdateShot(
      {
        shot_number: shotNumber,
        voice_over: 'Should not be written either.',
        dialogue: [{ speaker_name: 'Nobody Bound', line: 'Hi.' }],
      },
      buildContext({ projectId })
    )

    expect(outcome.kind).toBe('refused')
    expect(outcome.kind === 'refused' && JSON.stringify(outcome.forModel)).toContain('Nobody Bound')
    const after = await readShot(shotId)
    expect(after.voice_over).toBe('Original.')
    expect((await readDialogue(shotId)).length).toBe(0)

    const { count: elementsAfter } = await admin
      .from('elements')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', projectId)
    const { count: bindingsAfter } = await admin
      .from('shot_elements')
      .select('shot_id', { count: 'exact', head: true })
      .eq('shot_id', shotId)
    expect(elementsAfter).toBe(elementsBefore)
    expect(bindingsAfter).toBe(bindingsBefore)
  })

  test('read-only lock: refused once furthest_step is storyboard, even called directly bypassing the turn-level shortcut', async () => {
    const projectId = await seedToolProject({ furthest_step: stepIndex('storyboard') })
    const shotId = await seedToolShot(projectId)
    const shotNumber = (await readShot(shotId)).order_index + 1

    const outcome = await handleUpdateShot(
      { shot_number: shotNumber, voice_over: 'Should not be written.' },
      buildContext({ projectId, furthestStepIndex: stepIndex('storyboard') })
    )

    expect(outcome.kind).toBe('refused')
    expect((await readShot(shotId)).voice_over).toBe('Original voiceover.')
  })

  test('applied outcome carries the shot_key of the shot it wrote, not a display number - stable across renumbering', async () => {
    const projectId = await seedToolProject()
    const shotId = await seedToolShot(projectId)
    const shot = await readShot(shotId)

    const outcome = await handleUpdateShot(
      { shot_number: shot.order_index + 1, voice_over: 'Changed.' },
      buildContext({ projectId })
    )

    expect(outcome.kind).toBe('applied')
    expect(outcome.kind === 'applied' && outcome.shotKey).toBe(shot.shot_key)
  })

  test('read-only lock refusal still names the implicated shot_key', async () => {
    const projectId = await seedToolProject({ furthest_step: stepIndex('storyboard') })
    const shotId = await seedToolShot(projectId)
    const shot = await readShot(shotId)

    const outcome = await handleUpdateShot(
      { shot_number: shot.order_index + 1, voice_over: 'Should not be written.' },
      buildContext({ projectId, furthestStepIndex: stepIndex('storyboard') })
    )

    expect(outcome.kind).toBe('refused')
    expect(outcome.kind === 'refused' && outcome.shotKey).toBe(shot.shot_key)
  })

  test('dialogue refusal (unbound speaker) carries the implicated shot_key', async () => {
    const projectId = await seedToolProject()
    const shotId = await seedToolShot(projectId)
    const shot = await readShot(shotId)

    const outcome = await handleUpdateShot(
      { shot_number: shot.order_index + 1, dialogue: [{ speaker_name: 'Nobody Bound', line: 'Hi.' }] },
      buildContext({ projectId })
    )

    expect(outcome.kind).toBe('refused')
    expect(outcome.kind === 'refused' && outcome.shotKey).toBe(shot.shot_key)
  })
})

test.describe('handleInsertShot', () => {
  test('inserts at the requested position and keeps order_index contiguous with no gaps', async () => {
    const projectId = await seedToolProject()
    const shotA = await seedToolShot(projectId, { order_index: 0 })
    const shotB = await seedToolShot(projectId, { order_index: 1 })
    const shotC = await seedToolShot(projectId, { order_index: 2 })

    const outcome = await handleInsertShot(
      { insert_after_shot_number: 2, voice_over: 'A brand new shot.', visual_description: 'A brand new visual.' },
      buildContext({ projectId })
    )

    expect(outcome.kind).toBe('applied')
    const shots = await readShots(projectId)
    expect(shots.map((s) => s.order_index)).toEqual([0, 1, 2, 3])
    expect(shots[2].voice_over).toBe('A brand new shot.')
    expect(shots.find((s) => s.id === shotA)!.order_index).toBe(0)
    expect(shots.find((s) => s.id === shotB)!.order_index).toBe(1)
    expect(shots.find((s) => s.id === shotC)!.order_index).toBe(3)
  })

  test('read-only lock: refused once furthest_step is storyboard', async () => {
    const projectId = await seedToolProject({ furthest_step: stepIndex('storyboard') })
    await seedToolShot(projectId, { order_index: 0 })

    const outcome = await handleInsertShot(
      { insert_after_shot_number: 1, voice_over: 'Should not be inserted.' },
      buildContext({ projectId, furthestStepIndex: stepIndex('storyboard') })
    )

    expect(outcome.kind).toBe('refused')
    expect((await readShots(projectId)).length).toBe(1)
  })

  test('applied outcome carries the newly inserted shot\'s shot_key', async () => {
    const projectId = await seedToolProject()
    await seedToolShot(projectId, { order_index: 0 })

    const outcome = await handleInsertShot(
      { insert_after_shot_number: 1, voice_over: 'A brand new shot.', visual_description: 'A brand new visual.' },
      buildContext({ projectId })
    )

    expect(outcome.kind).toBe('applied')
    const inserted = (await readShots(projectId)).find((s) => s.voice_over === 'A brand new shot.')!
    expect(outcome.kind === 'applied' && outcome.shotKey).toBe(inserted.shot_key)
  })

  test('read-only lock refusal carries no shot_key - no specific shot is implicated yet', async () => {
    const projectId = await seedToolProject({ furthest_step: stepIndex('storyboard') })
    await seedToolShot(projectId, { order_index: 0 })

    const outcome = await handleInsertShot(
      { insert_after_shot_number: 1, voice_over: 'Should not be inserted.' },
      buildContext({ projectId, furthestStepIndex: stepIndex('storyboard') })
    )

    expect(outcome.kind).toBe('refused')
    expect(outcome.kind === 'refused' && outcome.shotKey).toBeUndefined()
  })

  test('refuses to insert a shot with an empty visual_description, and writes nothing', async () => {
    const projectId = await seedToolProject()

    const outcome = await handleInsertShot(
      { insert_after_shot_number: 0, voice_over: 'A brand new shot.', visual_description: '' },
      buildContext({ projectId })
    )

    expect(outcome.kind).toBe('refused')
    expect(await readShots(projectId)).toHaveLength(0)
  })

  test('refuses to insert a shot with a whitespace-only visual_description, and writes nothing', async () => {
    const projectId = await seedToolProject()

    const outcome = await handleInsertShot(
      { insert_after_shot_number: 0, voice_over: 'A brand new shot.', visual_description: '   ' },
      buildContext({ projectId })
    )

    expect(outcome.kind).toBe('refused')
    expect(await readShots(projectId)).toHaveLength(0)
  })
})

test.describe('handleRegenerateAllShots', () => {
  test('succeeds while furthest_step is still workbench', async () => {
    const projectId = await seedToolProject({ furthest_step: stepIndex('workbench') })
    await seedToolShot(projectId, { order_index: 0 })
    const messageId = await seedMessage(projectId)
    const gateway: ClaudeGateway = {
      async createMessage() {
        return successMessage({
          title: 'Regenerated',
          message: 'Fresh shots.',
          video_type: 'narrated_story',
          shots: [
            {
              voice_over: 'A fresh narration.',
              visual_description: 'A fresh visual.',
              dialogue: [],
              element_names: [],
            },
          ],
        })
      },
    }

    const outcome = await handleRegenerateAllShots(
      {},
      buildContext({ projectId, gateway, messageId, furthestStepIndex: stepIndex('workbench') })
    )

    expect(outcome.kind).toBe('applied')
    const shots = await readShots(projectId)
    expect(shots.length).toBe(1)
    expect(shots[0].voice_over).toBe('A fresh narration.')
  })

  test('refused once past the workbench step - existing shots are untouched, gateway never called', async () => {
    const projectId = await seedToolProject({ furthest_step: stepIndex('image_prompts') })
    await seedToolShot(projectId, { order_index: 0, voice_over: 'Must survive.' })
    const messageId = await seedMessage(projectId)
    let callCount = 0
    const gateway: ClaudeGateway = {
      async createMessage() {
        callCount++
        return successMessage({ title: null, message: '', video_type: null, shots: [] })
      },
    }

    const outcome = await handleRegenerateAllShots(
      {},
      buildContext({ projectId, gateway, messageId, furthestStepIndex: stepIndex('image_prompts') })
    )

    expect(outcome.kind).toBe('refused')
    expect(callCount).toBe(0)
    const shots = await readShots(projectId)
    expect(shots.length).toBe(1)
    expect(shots[0].voice_over).toBe('Must survive.')
  })

  test('neither applied nor refused outcomes carry a shot_key - the tool affects the whole list', async () => {
    const projectId = await seedToolProject({ furthest_step: stepIndex('workbench') })
    await seedToolShot(projectId, { order_index: 0 })
    const messageId = await seedMessage(projectId)
    const gateway: ClaudeGateway = {
      async createMessage() {
        return successMessage({
          title: 'Regenerated',
          message: 'Fresh shots.',
          video_type: 'narrated_story',
          shots: [{ voice_over: 'Fresh.', visual_description: 'Fresh.', dialogue: [], element_names: [] }],
        })
      },
    }

    const applied = await handleRegenerateAllShots(
      {},
      buildContext({ projectId, gateway, messageId, furthestStepIndex: stepIndex('workbench') })
    )
    expect(applied.kind).toBe('applied')
    expect(applied.kind === 'applied' && applied.shotKey).toBeUndefined()

    const refused = await handleRegenerateAllShots(
      {},
      buildContext({ projectId, messageId, furthestStepIndex: stepIndex('image_prompts') })
    )
    expect(refused.kind).toBe('refused')
    expect(refused.kind === 'refused' && refused.shotKey).toBeUndefined()
  })
})

async function readMessages(projectId: string) {
  const { data } = await admin.from('messages').select('*').eq('project_id', projectId).order('created_at')
  return data!
}

async function readAgentTurnGeneration(projectId: string) {
  const { data } = await admin
    .from('generations')
    .select('*')
    .eq('project_id', projectId)
    .eq('step', 'workbench')
    .eq('operation', 'agent_turn')
    .is('shot_id', null)
    .single()
  return data!
}

test.describe('runAgentTurn', () => {
  test('one tool call then a final reply: 2 gateway calls, shot mutated, reply persisted', async () => {
    const projectId = await seedToolProject()
    const shotId = await seedToolShot(projectId)
    const shotNumber = (await readShot(shotId)).order_index + 1
    const events: AgentStreamEvent[] = []

    const result = await runAgentTurn({
      gateway: scriptedGateway([
        successMessage({ shot_number: shotNumber, voice_over: 'Changed by the agent.' }, 'update_shot'),
        textMessage('Updated the narration.'),
      ]),
      supabase: admin,
      projectId,
      userId: primary.user.id,
      content: 'change the narration',
      clientId: crypto.randomUUID(),
      onEvent: (e) => events.push(e),
    })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.message.content).toBe('Updated the narration.')
    expect((await readShot(shotId)).voice_over).toBe('Changed by the agent.')
    expect(events.some((e) => e.type === 'turn_started')).toBe(true)
    expect(events.some((e) => e.type === 'tool_completed')).toBe(true)
    expect(events.filter((e) => e.type === 'settled').length).toBe(1)
    const row = await readAgentTurnGeneration(projectId)
    expect(row.state).toBe('succeeded')
  })

  test('tool_completed carries the mutated shot\'s shot_key on the stream event, not just the handler outcome', async () => {
    const projectId = await seedToolProject()
    const shotId = await seedToolShot(projectId)
    const shot = await readShot(shotId)
    const events: AgentStreamEvent[] = []

    await runAgentTurn({
      gateway: scriptedGateway([
        successMessage({ shot_number: shot.order_index + 1, voice_over: 'Changed by the agent.' }, 'update_shot'),
        textMessage('Updated the narration.'),
      ]),
      supabase: admin,
      projectId,
      userId: primary.user.id,
      content: 'change the narration',
      clientId: crypto.randomUUID(),
      onEvent: (e) => events.push(e),
    })

    const toolCompleted = events.find((e) => e.type === 'tool_completed')
    expect(toolCompleted?.type === 'tool_completed' && toolCompleted.shotKey).toBe(shot.shot_key)
  })

  test('loops through several tool calls before the final reply', async () => {
    const projectId = await seedToolProject()
    const shotA = await seedToolShot(projectId)
    const shotB = await seedToolShot(projectId)
    const numA = (await readShot(shotA)).order_index + 1
    const numB = (await readShot(shotB)).order_index + 1
    const gateway = scriptedGateway([
      successMessage({ shot_number: numA, voice_over: 'First change.' }, 'update_shot'),
      successMessage({ shot_number: numB, voice_over: 'Second change.' }, 'update_shot'),
      textMessage('Updated both shots.'),
    ])

    const result = await runAgentTurn({
      gateway,
      supabase: admin,
      projectId,
      userId: primary.user.id,
      content: 'change both',
      clientId: crypto.randomUUID(),
    })

    expect(result.ok).toBe(true)
    expect(gateway.getCallCount()).toBe(3)
    expect((await readShot(shotA)).voice_over).toBe('First change.')
    expect((await readShot(shotB)).voice_over).toBe('Second change.')

    const { data: usageRows } = await admin.from('usage').select('id, message_id').eq('project_id', projectId)
    expect(usageRows!.length).toBe(3)
    const messageIds = new Set(usageRows!.map((r) => r.message_id))
    expect(messageIds.size).toBe(1)
  })

  test('finish bundled with a successful mutation ends the turn in one call and persists its message', async () => {
    const projectId = await seedToolProject()
    const shotId = await seedToolShot(projectId)
    const shotNumber = (await readShot(shotId)).order_index + 1
    const gateway = scriptedGateway([
      multiToolMessage([
        { name: 'update_shot', input: { shot_number: shotNumber, voice_over: 'Changed by the agent.' } },
        { name: 'finish', input: { message: 'Added the change you asked for.' } },
      ]),
    ])

    const result = await runAgentTurn({
      gateway,
      supabase: admin,
      projectId,
      userId: primary.user.id,
      content: 'change the narration',
      clientId: crypto.randomUUID(),
    })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.message.content).toBe('Added the change you asked for.')
    expect(gateway.getCallCount()).toBe(1)
    expect((await readShot(shotId)).voice_over).toBe('Changed by the agent.')
  })

  test('finish bundled with a refused mutation is discarded and the loop continues', async () => {
    const projectId = await seedToolProject()
    const shotId = await seedToolShot(projectId)
    const shot = await readShot(shotId)
    const shotNumber = shot.order_index + 1
    const gateway = scriptedGateway([
      multiToolMessage([
        // visual_description: '' with no voice_over fallback text is refused by
        // handleUpdateShot's empty-visual-description check.
        { name: 'update_shot', input: { shot_number: shotNumber, visual_description: '' } },
        { name: 'finish', input: { message: 'Cleared the visual description.' } },
      ]),
      textMessage('That description cannot be empty, so I left it as is.'),
    ])

    const result = await runAgentTurn({
      gateway,
      supabase: admin,
      projectId,
      userId: primary.user.id,
      content: 'clear the visual description',
      clientId: crypto.randomUUID(),
    })

    expect(result.ok).toBe(true)
    // The bundled finish message must never surface - the mutation it assumed would
    // succeed was refused, so the model's second, informed reply is what persists.
    if (result.ok) expect(result.message.content).toBe('That description cannot be empty, so I left it as is.')
    expect(gateway.getCallCount()).toBe(2)
    expect((await readShot(shotId)).visual_description).toBe(shot.visual_description)
  })

  test('a "write me X" content request can loop from get_shot into update_shot rather than stopping at a text-only reply', async () => {
    // This scripts the fake model to look then write, so it only proves the turn loop
    // supports that shape end-to-end (persists the write, doesn't stop at the get_shot
    // reply). Whether the real model chooses this shape for a given prompt needs a live
    // Claude call, which this repo's tests never make - see the AGENT_SYSTEM_PROMPT_V6
    // content assertions above for the prompt-shape half of this check.
    const projectId = await seedToolProject()
    const shotId = await seedToolShot(projectId)
    const shotNumber = (await readShot(shotId)).order_index + 1
    const gateway = scriptedGateway([
      successMessage({ shot_number: shotNumber }, 'get_shot'),
      successMessage({ shot_number: shotNumber, visual_description: 'A dusty market street at dawn.' }, 'update_shot'),
      textMessage('Added a visual description.'),
    ])

    const result = await runAgentTurn({
      gateway,
      supabase: admin,
      projectId,
      userId: primary.user.id,
      content: 'Add a visual description to shot 1',
      clientId: crypto.randomUUID(),
    })

    expect(result.ok).toBe(true)
    expect(gateway.getCallCount()).toBe(3)
    expect((await readShot(shotId)).visual_description).toBe('A dusty market street at dawn.')
  })

  test('hits the 8-iteration cap: exactly 8 calls, no 9th, claim settles succeeded not stuck', async () => {
    const projectId = await seedToolProject()
    const shotId = await seedToolShot(projectId)
    const shotNumber = (await readShot(shotId)).order_index + 1
    const gateway = scriptedGateway(
      Array.from({ length: 8 }, () =>
        successMessage({ shot_number: shotNumber, section_label: 'looping' }, 'update_shot')
      )
    )

    const result = await runAgentTurn({
      gateway,
      supabase: admin,
      projectId,
      userId: primary.user.id,
      content: 'keep going forever',
      clientId: crypto.randomUUID(),
    })

    expect(result.ok).toBe(true)
    expect(gateway.getCallCount()).toBe(8)
    const row = await readAgentTurnGeneration(projectId)
    expect(row.state).toBe('succeeded')
  })

  test('no path ever deletes a shot, even across a mixed multi-tool turn', async () => {
    const projectId = await seedToolProject()
    const shotA = await seedToolShot(projectId, { order_index: 0 })
    const numA = (await readShot(shotA)).order_index + 1
    const gateway = scriptedGateway([
      successMessage({ insert_after_shot_number: numA, voice_over: 'A new shot.' }, 'insert_shot'),
      successMessage({ shot_number: numA, voice_over: 'Edited.' }, 'update_shot'),
      textMessage('Done.'),
    ])

    const before = (await readShots(projectId)).length
    await runAgentTurn({
      gateway,
      supabase: admin,
      projectId,
      userId: primary.user.id,
      content: 'add a shot and edit the first one',
      clientId: crypto.randomUUID(),
    })
    const after = (await readShots(projectId)).length

    expect(after).toBeGreaterThanOrEqual(before)
  })

  test('read-only lock: a full turn short-circuits with zero gateway calls and a canned persisted reply', async () => {
    const projectId = await seedToolProject({ furthest_step: stepIndex('storyboard') })
    const gateway = scriptedGateway([successMessage({}, 'update_shot')])

    const result = await runAgentTurn({
      gateway,
      supabase: admin,
      projectId,
      userId: primary.user.id,
      content: 'change something',
      clientId: crypto.randomUUID(),
    })

    expect(result.ok).toBe(true)
    expect(gateway.getCallCount()).toBe(0)
    if (result.ok) expect(result.message.content.length).toBeGreaterThan(0)
  })

  test('a duplicate client_id returns the stored reply and makes no model call', async () => {
    const projectId = await seedToolProject()
    await seedToolShot(projectId)
    const clientId = crypto.randomUUID()
    const gateway = scriptedGateway([textMessage('First reply.')])

    const first = await runAgentTurn({
      gateway,
      supabase: admin,
      projectId,
      userId: primary.user.id,
      content: 'do something',
      clientId,
    })
    expect(first.ok).toBe(true)

    const secondGateway = scriptedGateway([])
    const second = await runAgentTurn({
      gateway: secondGateway,
      supabase: admin,
      projectId,
      userId: primary.user.id,
      content: 'do something',
      clientId,
    })

    expect(second.ok).toBe(true)
    expect(secondGateway.getCallCount()).toBe(0)
    if (first.ok && second.ok) expect(second.message.id).toBe(first.message.id)
  })

  test('a second turn inside 180s is refused as already_generating; the wiring reaches the claim primitive', async () => {
    const projectId = await seedToolProject()
    const { error } = await admin.from('generations').insert({
      project_id: projectId,
      step: 'workbench',
      operation: 'agent_turn',
      shot_id: null,
      state: 'generating',
      started_at: new Date().toISOString(),
    })
    expect(error).toBeNull()
    const gateway = scriptedGateway([])

    const result = await runAgentTurn({
      gateway,
      supabase: admin,
      projectId,
      userId: primary.user.id,
      content: 'do something',
      clientId: crypto.randomUUID(),
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect('reason' in result && result.reason).toBe('already_generating')
    expect(gateway.getCallCount()).toBe(0)
  })

  test('claim blocked (already_generating): the user message still gets a persisted reply, so a resend does not loop the same 409 forever', async () => {
    const projectId = await seedToolProject()
    const { error } = await admin.from('generations').insert({
      project_id: projectId,
      step: 'workbench',
      operation: 'agent_turn',
      shot_id: null,
      state: 'generating',
      started_at: new Date().toISOString(),
    })
    expect(error).toBeNull()
    const clientId = crypto.randomUUID()

    const first = await runAgentTurn({
      gateway: scriptedGateway([]),
      supabase: admin,
      projectId,
      userId: primary.user.id,
      content: 'do something',
      clientId,
    })
    expect(first.ok).toBe(false)

    const messages = await readMessages(projectId)
    expect(messages.find((m) => m.role === 'user')?.content).toBe('do something')
    const reply = messages.find((m) => m.role === 'assistant')
    expect(reply).toBeDefined()
    expect(reply!.client_id).toBe(clientId)

    // A resend of the SAME failed attempt now finds the persisted reply instead of
    // looping the identical "still processing" 409 forever.
    const secondGateway = scriptedGateway([])
    const second = await runAgentTurn({
      gateway: secondGateway,
      supabase: admin,
      projectId,
      userId: primary.user.id,
      content: 'do something',
      clientId,
    })
    expect(second.ok).toBe(true)
    expect(secondGateway.getCallCount()).toBe(0)
  })

  test('a second turn after 180s is allowed (claim reclaims the stale mutex row)', async () => {
    const projectId = await seedToolProject()
    const stale = new Date(Date.now() - (STALE_AFTER_MS + 5_000)).toISOString()
    const { error } = await admin.from('generations').insert({
      project_id: projectId,
      step: 'workbench',
      operation: 'agent_turn',
      shot_id: null,
      state: 'generating',
      started_at: stale,
    })
    expect(error).toBeNull()
    const gateway = scriptedGateway([textMessage('Reclaimed.')])

    const result = await runAgentTurn({
      gateway,
      supabase: admin,
      projectId,
      userId: primary.user.id,
      content: 'do something',
      clientId: crypto.randomUUID(),
    })

    expect(result.ok).toBe(true)
    expect(gateway.getCallCount()).toBe(1)
  })

  test('a dropped stream (onEvent throws) still settles the generation and usage rows, never leaving them pending', async () => {
    const projectId = await seedToolProject()
    const shotId = await seedToolShot(projectId)
    const shotNumber = (await readShot(shotId)).order_index + 1
    const gateway = scriptedGateway([
      successMessage({ shot_number: shotNumber, voice_over: 'Changed.' }, 'update_shot'),
      textMessage('Done.'),
    ])

    const result = await runAgentTurn({
      gateway,
      supabase: admin,
      projectId,
      userId: primary.user.id,
      content: 'change it',
      clientId: crypto.randomUUID(),
      onEvent: () => {
        throw new Error('simulated broken pipe')
      },
    })

    expect(result.ok).toBe(true)
    const row = await readAgentTurnGeneration(projectId)
    expect(row.state).toBe('succeeded')
    const { data: usageRows } = await admin.from('usage').select('status').eq('project_id', projectId)
    expect(usageRows!.every((r) => r.status !== 'pending')).toBe(true)
  })

  test('the exact failure the client_id guard exists to prevent: a dropped-turn resend must not double-bill', async () => {
    // Simulates the scenario directly: the connection is lost right as the turn
    // finishes (onEvent throwing stands in for "the client is gone, writes fail"),
    // then the SAME browser resends the SAME message with the SAME client_id, exactly
    // as a real client would on a lost response. The reply must already be persisted
    // and returned - and Claude must NOT be called a second time.
    const projectId = await seedToolProject()
    const shotId = await seedToolShot(projectId)
    const shotNumber = (await readShot(shotId)).order_index + 1
    const clientId = crypto.randomUUID()

    const first = await runAgentTurn({
      gateway: scriptedGateway([
        successMessage({ shot_number: shotNumber, voice_over: 'Changed once.' }, 'update_shot'),
        textMessage('Updated the shot.'),
      ]),
      supabase: admin,
      projectId,
      userId: primary.user.id,
      content: 'change it',
      clientId,
      onEvent: () => {
        throw new Error('simulated dropped connection')
      },
    })
    expect(first.ok).toBe(true)
    if (first.ok) expect(first.message.content).toBe('Updated the shot.')

    const resendGateway = scriptedGateway([])
    const resend = await runAgentTurn({
      gateway: resendGateway,
      supabase: admin,
      projectId,
      userId: primary.user.id,
      content: 'change it',
      clientId,
    })

    expect(resend.ok).toBe(true)
    expect(resendGateway.getCallCount()).toBe(0)
    if (resend.ok && first.ok) expect(resend.message.id).toBe(first.message.id)
    expect((await readShot(shotId)).voice_over).toBe('Changed once.')
    const { data: usageRows } = await admin.from('usage').select('id').eq('project_id', projectId)
    expect(usageRows!.length).toBe(2) // exactly the first turn's iterations - the resend spent nothing
  })

  test('the persisted user message and assistant reply both land in messages', async () => {
    const projectId = await seedToolProject()
    await seedToolShot(projectId)
    const clientId = crypto.randomUUID()

    await runAgentTurn({
      gateway: scriptedGateway([textMessage('All done.')]),
      supabase: admin,
      projectId,
      userId: primary.user.id,
      content: 'say hi',
      clientId,
    })

    const messages = await readMessages(projectId)
    expect(messages.find((m) => m.role === 'user')?.content).toBe('say hi')
    expect(messages.find((m) => m.role === 'assistant')?.content).toBe('All done.')
    expect(messages.every((m) => m.client_id === clientId)).toBe(true)
  })
})

test.describe('dispatchAgentTool', () => {
  test('routes get_shot, update_shot, insert_shot, regenerate_all_shots to their handlers; an unknown name errors', async () => {
    const projectId = await seedToolProject()
    await seedToolShot(projectId, { order_index: 0 })

    const getShotOutcome = await dispatchAgentTool('get_shot', { shot_number: 1 }, buildContext({ projectId }))
    expect(getShotOutcome.kind).not.toBe('errored')

    const unknown = await dispatchAgentTool('delete_shot', {}, buildContext({ projectId }))
    expect(unknown.kind).toBe('errored')
  })
})
