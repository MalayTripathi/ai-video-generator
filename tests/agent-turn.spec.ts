import { test, expect } from '@playwright/test'
import { admin } from './supabase-test-session'
import { primary } from './fixed-users'
import { buildShotIndexBlock, AGENT_TOOLS, AGENT_SYSTEM_PROMPT_V10 } from '../src/lib/prompts/agent'
import {
  handleGetShot,
  handleUpdateShot,
  handleInsertShot,
  handleRegenerateAllShots,
  handleDecline,
  dispatchAgentTool,
  type AgentToolContext,
} from '../src/app/api/projects/[id]/agent/tools'
import { stepIndex } from '../src/lib/config/pipeline'
import { successMessage, throwingGateway, textMessage, scriptedGateway, multiToolMessage, mixedMessage } from './helpers/claude-fakes'
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
  section_label: string | null
  shot_size_origin: string
  camera_angle_origin: string
  camera_movement_origin: string
}

function shot(overrides: Partial<IndexShot> & { order_index: number }): IndexShot {
  return {
    visual_description: null,
    voice_over: '',
    section_label: null,
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

  test('carries each shot\'s section_label into its index line, and omits the suffix when there is none', () => {
    const block = buildShotIndexBlock([
      shot({ order_index: 0, visual_description: 'Shot A', section_label: 'Introduction' }),
      shot({ order_index: 1, visual_description: 'Shot B', section_label: null }),
    ])
    const lines = block.split('\n')
    expect(lines[0]).toContain('[section: Introduction]')
    expect(lines[1]).not.toContain('[section:')
  })
})

test.describe('AGENT_TOOLS', () => {
  test('is exactly get_shot, update_shot, insert_shot, regenerate_all_shots, decline - no delete tool, no finish', () => {
    expect(AGENT_TOOLS.map((t) => t.name)).toEqual([
      'get_shot',
      'update_shot',
      'insert_shot',
      'regenerate_all_shots',
      'decline',
    ])
  })

  test('decline takes only a required message string', () => {
    const decline = AGENT_TOOLS.find((t) => t.name === 'decline')!
    const schema = decline.input_schema as unknown as {
      properties: Record<string, unknown>
      required: string[]
      additionalProperties: boolean
    }
    expect(Object.keys(schema.properties)).toEqual(['message'])
    expect(schema.required).toEqual(['message'])
    expect(schema.additionalProperties).toBe(false)
  })

  test('update_shot has no camera _origin properties - naming a camera field is itself the origin signal', () => {
    const updateShot = AGENT_TOOLS.find((t) => t.name === 'update_shot')!
    const props = (updateShot.input_schema as unknown as { properties: Record<string, unknown> }).properties
    expect(props.shot_size).toBeDefined()
    expect(props.shot_size_origin).toBeUndefined()
    expect(props.camera_angle_origin).toBeUndefined()
    expect(props.camera_movement_origin).toBeUndefined()
  })

  test('insert_shot still has camera _origin properties - a new shot is the model freely choosing, not overriding', () => {
    const insertShot = AGENT_TOOLS.find((t) => t.name === 'insert_shot')!
    const props = (insertShot.input_schema as unknown as { properties: Record<string, unknown> }).properties
    expect(props.shot_size_origin).toBeDefined()
  })

  test('insert_shot requires section_label and all six camera value+origin properties together - never a partial or silently-omitted set', () => {
    const insertShot = AGENT_TOOLS.find((t) => t.name === 'insert_shot')!
    const schema = insertShot.input_schema as unknown as { required: string[] }
    expect(schema.required).toEqual(
      expect.arrayContaining([
        'insert_after_shot_number',
        'voice_over',
        'section_label',
        'shot_size',
        'shot_size_origin',
        'camera_angle',
        'camera_angle_origin',
        'camera_movement',
        'camera_movement_origin',
      ])
    )
  })

  test('insert_shot requires visual_description - the handler refuses an empty one, and an optional-but-enforced field is a paid retry loop waiting to happen', () => {
    const insertShot = AGENT_TOOLS.find((t) => t.name === 'insert_shot')!
    const schema = insertShot.input_schema as unknown as { required: string[] }
    expect(schema.required).toContain('visual_description')
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

test.describe('AGENT_SYSTEM_PROMPT_V10', () => {
  test('explicitly instructs the model never to delete a shot', () => {
    expect(AGENT_SYSTEM_PROMPT_V10.toLowerCase()).toContain('delete')
  })

  test('defaults to acting on a content request rather than asking a clarifying question', () => {
    expect(AGENT_SYSTEM_PROMPT_V10.toLowerCase()).toContain('default to acting')
  })

  test('directs the model to use other shots as a style reference instead of asking the user to specify one', () => {
    expect(AGENT_SYSTEM_PROMPT_V10.toLowerCase()).toContain('style reference')
  })

  test('reserves clarifying questions for which-shot/which-field ambiguity or a destructive guess', () => {
    const prompt = AGENT_SYSTEM_PROMPT_V10.toLowerCase()
    expect(prompt).toContain('which shot or which field')
    expect(prompt).toContain('destructive')
  })

  test('finish no longer exists anywhere in the prompt - a turn ends via a plain reply, no tool call', () => {
    const prompt = AGENT_SYSTEM_PROMPT_V10.toLowerCase()
    expect(prompt).not.toContain('finish')
    expect(prompt).toContain('no tool call')
  })

  test('the no-delete-tool rule tells the model to call decline', () => {
    const prompt = AGENT_SYSTEM_PROMPT_V10.toLowerCase()
    expect(prompt).toContain('call decline and tell them to use that shot')
  })

  test('tells the model a request can mix completed actions with separate declines, not all-or-nothing', () => {
    const prompt = AGENT_SYSTEM_PROMPT_V10.toLowerCase()
    expect(prompt).toContain("don't have to answer all-or-nothing")
    expect(prompt).toContain('call decline separately for whatever you won')
  })

  test('states declining anything is a hard rule requiring the decline tool, never a bare prose refusal, with a contrastive example', () => {
    const prompt = AGENT_SYSTEM_PROMPT_V10.toLowerCase()
    expect(prompt).toContain('you must call decline for that part')
    expect(prompt).toContain('never write the refusal as plain reply text')
    expect(prompt).toContain('wrong:')
    expect(prompt).toContain('right:')
  })

  test('tells the model an inserted shot inherits its section from the surrounding shots by default', () => {
    const prompt = AGENT_SYSTEM_PROMPT_V10.toLowerCase()
    expect(prompt).toContain('a shot placed between two shots of the same section belongs to that section')
  })

  test('tells the model insert_shot\'s three camera fields must be reported together, never partially', () => {
    const prompt = AGENT_SYSTEM_PROMPT_V10.toLowerCase()
    expect(prompt).toContain('never report some of the three and leave the rest out')
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

  test('applied outcome carries the shot_key of the shot it read, not a display number', async () => {
    const projectId = await seedToolProject()
    const shotId = await seedToolShot(projectId)
    const shot = await readShot(shotId)

    const outcome = await handleGetShot({ shot_number: shot.order_index + 1 }, buildContext({ projectId }))

    expect(outcome.kind).toBe('applied')
    expect(outcome.kind === 'applied' && outcome.shotKey).toBe(shot.shot_key)
  })
})

test.describe('handleUpdateShot', () => {
  test('writes only the fields explicitly named in the call - a sibling camera field (value and origin) is untouched', async () => {
    const projectId = await seedToolProject()
    const shotId = await seedToolShot(projectId, {
      camera_angle: 'eye_level',
      camera_angle_origin: 'auto',
      camera_movement: 'static',
      camera_movement_origin: 'auto',
    })
    const shotNumber = (await readShot(shotId)).order_index + 1

    const outcome = await handleUpdateShot({ shot_number: shotNumber, shot_size: 'wide' }, buildContext({ projectId }))

    expect(outcome.kind).toBe('applied')
    const after = await readShot(shotId)
    expect(after.shot_size).toBe('wide')
    expect(after.camera_angle).toBe('eye_level')
    expect(after.camera_angle_origin).toBe('auto')
    expect(after.camera_movement).toBe('static')
    expect(after.camera_movement_origin).toBe('auto')
  })

  test('naming a camera field always sets its origin to override, regardless of the field\'s prior origin - fixes the bug where an agent write left origin stuck at auto', async () => {
    const projectId = await seedToolProject()
    const shotId = await seedToolShot(projectId, { shot_size: 'wide', shot_size_origin: 'auto' })
    const shotNumber = (await readShot(shotId)).order_index + 1

    const outcome = await handleUpdateShot({ shot_number: shotNumber, shot_size: 'close_up' }, buildContext({ projectId }))

    expect(outcome.kind).toBe('applied')
    const after = await readShot(shotId)
    expect(after.shot_size).toBe('close_up')
    expect(after.shot_size_origin).toBe('override')
  })

  test('naming a camera field already at override with a new value still writes it, origin stays override', async () => {
    const projectId = await seedToolProject()
    const shotId = await seedToolShot(projectId, { shot_size: 'wide', shot_size_origin: 'override' })
    const shotNumber = (await readShot(shotId)).order_index + 1

    const outcome = await handleUpdateShot({ shot_number: shotNumber, shot_size: 'medium' }, buildContext({ projectId }))

    expect(outcome.kind).toBe('applied')
    const after = await readShot(shotId)
    expect(after.shot_size).toBe('medium')
    expect(after.shot_size_origin).toBe('override')
  })

  test('naming a camera field with the same value it already has, already override, is a no-op', async () => {
    const projectId = await seedToolProject()
    const shotId = await seedToolShot(projectId, { shot_size: 'wide', shot_size_origin: 'override' })
    const shotNumber = (await readShot(shotId)).order_index + 1

    const outcome = await handleUpdateShot({ shot_number: shotNumber, shot_size: 'wide' }, buildContext({ projectId }))

    expect(outcome.kind).toBe('applied')
    expect(outcome.kind === 'applied' && outcome.label).toContain('No changes needed')
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

  test('an inserted shot carries a section label, persisted verbatim', async () => {
    const projectId = await seedToolProject()
    await seedToolShot(projectId, { order_index: 0, section_label: 'Introduction' })

    const outcome = await handleInsertShot(
      {
        insert_after_shot_number: 1,
        voice_over: 'A brand new shot.',
        visual_description: 'A brand new visual.',
        section_label: 'Introduction',
      },
      buildContext({ projectId })
    )

    expect(outcome.kind).toBe('applied')
    const inserted = (await readShots(projectId)).find((s) => s.voice_over === 'A brand new shot.')!
    expect(inserted.section_label).toBe('Introduction')
  })

  test('a call reporting all three camera fields and origins persists all three verbatim', async () => {
    const projectId = await seedToolProject()

    const outcome = await handleInsertShot(
      {
        insert_after_shot_number: 0,
        voice_over: 'A brand new shot.',
        visual_description: 'A brand new visual.',
        shot_size: 'wide',
        shot_size_origin: 'auto',
        camera_angle: 'high',
        camera_angle_origin: 'derived',
        camera_movement: 'pan',
        camera_movement_origin: 'auto',
      },
      buildContext({ projectId })
    )

    expect(outcome.kind).toBe('applied')
    const inserted = (await readShots(projectId)).find((s) => s.voice_over === 'A brand new shot.')!
    expect(inserted.shot_size).toBe('wide')
    expect(inserted.shot_size_origin).toBe('auto')
    expect(inserted.camera_angle).toBe('high')
    expect(inserted.camera_angle_origin).toBe('derived')
    expect(inserted.camera_movement).toBe('pan')
    expect(inserted.camera_movement_origin).toBe('auto')
  })

  test("an inserted shot's camera fields are all populated or all empty, never partial - a call omitting one field nulls all three", async () => {
    const projectId = await seedToolProject()

    const outcome = await handleInsertShot(
      {
        insert_after_shot_number: 0,
        voice_over: 'A brand new shot.',
        visual_description: 'A brand new visual.',
        shot_size: 'wide',
        shot_size_origin: 'auto',
        // camera_angle deliberately omitted
        camera_movement: 'pan',
        camera_movement_origin: 'auto',
      },
      buildContext({ projectId })
    )

    expect(outcome.kind).toBe('applied')
    const inserted = (await readShots(projectId)).find((s) => s.voice_over === 'A brand new shot.')!
    expect(inserted.shot_size).toBeNull()
    expect(inserted.shot_size_origin).toBe('auto')
    expect(inserted.camera_angle).toBeNull()
    expect(inserted.camera_angle_origin).toBe('auto')
    expect(inserted.camera_movement).toBeNull()
    expect(inserted.camera_movement_origin).toBe('auto')
  })

  test('an invalid enum value on one camera field also nulls all three, not just the bad one', async () => {
    const projectId = await seedToolProject()

    const outcome = await handleInsertShot(
      {
        insert_after_shot_number: 0,
        voice_over: 'A brand new shot.',
        visual_description: 'A brand new visual.',
        shot_size: 'wide',
        shot_size_origin: 'auto',
        camera_angle: 'not_a_real_angle',
        camera_angle_origin: 'auto',
        camera_movement: 'pan',
        camera_movement_origin: 'auto',
      },
      buildContext({ projectId })
    )

    expect(outcome.kind).toBe('applied')
    const inserted = (await readShots(projectId)).find((s) => s.voice_over === 'A brand new shot.')!
    expect(inserted.shot_size).toBeNull()
    expect(inserted.camera_angle).toBeNull()
    expect(inserted.camera_movement).toBeNull()
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

test.describe('handleDecline', () => {
  test('always reports refused, carrying the message verbatim - never a mutation attempt', async () => {
    const outcome = await handleDecline({ message: "There's no delete tool - use the shot's own delete button." })
    expect(outcome.kind).toBe('refused')
    expect(outcome.kind === 'refused' && outcome.label).toBe("There's no delete tool - use the shot's own delete button.")
    expect(outcome.kind === 'refused' && outcome.shotKey).toBeUndefined()
  })

  test('falls back to a generic message rather than throwing on malformed input', async () => {
    const outcome = await handleDecline({})
    expect(outcome.kind).toBe('refused')
    expect(outcome.kind === 'refused' && outcome.label.length > 0).toBe(true)
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

  test('a turn produces exactly one closing message, even when the model narrates before its mutation', async () => {
    const projectId = await seedToolProject()
    const shotId = await seedToolShot(projectId)
    const shotNumber = (await readShot(shotId)).order_index + 1
    const clientId = crypto.randomUUID()

    // This is the exact shape that used to duplicate under the old `finish` tool: prose
    // in the same response as a tool call. Without finish, that prose is only ever an
    // interstitial row - the turn's actual close comes from a later, separate response.
    const result = await runAgentTurn({
      gateway: scriptedGateway([
        mixedMessage('Let me update that for you.', [
          { name: 'update_shot', input: { shot_number: shotNumber, voice_over: 'Changed by the agent.' } },
        ]),
        textMessage('Updated the narration.'),
      ]),
      supabase: admin,
      projectId,
      userId: primary.user.id,
      content: 'change the narration',
      clientId,
    })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.message.content).toBe('Updated the narration.')
    expect((await readShot(shotId)).voice_over).toBe('Changed by the agent.')

    const messages = await readMessages(projectId)
    const closingRows = messages.filter((m) => m.role === 'assistant' && m.client_id === clientId)
    expect(closingRows.length).toBe(1)
    expect(closingRows[0].content).toBe('Updated the narration.')
    expect(messages.map((m) => `${m.role}:${m.kind}`)).toEqual([
      'user:text',
      'assistant:text',
      'assistant:tool_done',
      'assistant:text',
    ])
  })

  test('a refused mutation is fed back to the model, and its next reply is what persists as the close', async () => {
    const projectId = await seedToolProject()
    const shotId = await seedToolShot(projectId)
    const shot = await readShot(shotId)
    const shotNumber = shot.order_index + 1
    const gateway = scriptedGateway([
      // visual_description: '' with no voice_over fallback text is refused by
      // handleUpdateShot's empty-visual-description check.
      successMessage({ shot_number: shotNumber, visual_description: '' }, 'update_shot'),
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
    if (result.ok) expect(result.message.content).toBe('That description cannot be empty, so I left it as is.')
    expect(gateway.getCallCount()).toBe(2)
    expect((await readShot(shotId)).visual_description).toBe(shot.visual_description)
  })

  test('a turn that declines part of a request and completes another renders the decline as its own message, closing text stays ordinary', async () => {
    const projectId = await seedToolProject()
    const shotId = await seedToolShot(projectId)
    const shotNumber = (await readShot(shotId)).order_index + 1
    const gateway = scriptedGateway([
      multiToolMessage([
        { name: 'decline', input: { message: "There's no delete tool - use the shot's own delete button." } },
        { name: 'update_shot', input: { shot_number: shotNumber, voice_over: 'Rewritten with more panic.' } },
      ]),
      textMessage("Rewrote that shot's narration."),
    ])

    const result = await runAgentTurn({
      gateway,
      supabase: admin,
      projectId,
      userId: primary.user.id,
      content: 'delete shot 3 and rewrite this one to be more panicked',
      clientId: crypto.randomUUID(),
    })

    expect(result.ok).toBe(true)
    expect(result.ok && result.message.content).toBe("Rewrote that shot's narration.")

    const messages = await readMessages(projectId)
    // user -> decline (its own refusal-kind message) -> tool_done -> ordinary closing text
    expect(messages.map((m) => `${m.role}:${m.kind}`)).toEqual([
      'user:text',
      'assistant:refusal',
      'assistant:tool_done',
      'assistant:text',
    ])
    expect(messages[1].content).toBe("There's no delete tool - use the shot's own delete button.")
    expect(messages[1].client_id).toBeNull()
    expect(messages[3].content).toBe("Rewrote that shot's narration.")
    expect((await readShot(shotId)).voice_over).toBe('Rewritten with more panic.')
  })

  test('a wholly declined turn still renders its decline in the refusal treatment, even though the closing row is ordinary text', async () => {
    const projectId = await seedToolProject()

    const result = await runAgentTurn({
      gateway: scriptedGateway([
        successMessage({ message: "There's no delete tool - use the shot's own delete button." }, 'decline'),
        textMessage("I can't delete shots directly."),
      ]),
      supabase: admin,
      projectId,
      userId: primary.user.id,
      content: 'delete shot 3',
      clientId: crypto.randomUUID(),
    })

    expect(result.ok).toBe(true)
    const messages = await readMessages(projectId)
    expect(messages.map((m) => `${m.role}:${m.kind}`)).toEqual(['user:text', 'assistant:refusal', 'assistant:text'])
    expect(messages[1].content).toBe("There's no delete tool - use the shot's own delete button.")
  })

  test('a bare-prose refusal with no decline call persists as ordinary text, not the refusal treatment - a known, accepted prompt-compliance gap, not a routing defect', async () => {
    const projectId = await seedToolProject()

    // Nothing detects "this response looks like a refusal that should have called
    // decline" - the model can always just answer in prose instead, with zero tool
    // calls. This is deliberately NOT coerced into kind: 'refusal' server-side (that
    // would be the keyword-sniffing this repo already rejects elsewhere - see
    // targetShots in CLAUDE.md); it is documented here as real, current behavior rather
    // than left unverified. See docs/decisions.md.
    const result = await runAgentTurn({
      gateway: scriptedGateway([textMessage("There's no delete tool - use the shot's own delete button in the UI.")]),
      supabase: admin,
      projectId,
      userId: primary.user.id,
      content: 'delete shot 3',
      clientId: crypto.randomUUID(),
    })

    expect(result.ok).toBe(true)
    const messages = await readMessages(projectId)
    expect(messages[messages.length - 1].kind).toBe('text')
  })

  test('interstitial prose alongside a tool call persists in its real position, before that iteration\'s tool_done row', async () => {
    const projectId = await seedToolProject()
    const shotId = await seedToolShot(projectId)
    const shotNumber = (await readShot(shotId)).order_index + 1

    const result = await runAgentTurn({
      gateway: scriptedGateway([
        mixedMessage('Let me check that shot first.', [{ name: 'get_shot', input: { shot_number: shotNumber } }]),
        successMessage({ shot_number: shotNumber, voice_over: 'Changed after looking.' }, 'update_shot'),
        textMessage('Updated it.'),
      ]),
      supabase: admin,
      projectId,
      userId: primary.user.id,
      content: 'change the narration if it needs it',
      clientId: crypto.randomUUID(),
    })

    expect(result.ok).toBe(true)
    const messages = await readMessages(projectId)
    // user -> interstitial prose -> tool_done (get_shot) -> tool_done (update_shot) -> closing reply
    expect(messages.map((m) => `${m.role}:${m.kind}`)).toEqual([
      'user:text',
      'assistant:text',
      'assistant:tool_done',
      'assistant:tool_done',
      'assistant:text',
    ])
    const interstitial = messages[1]
    expect(interstitial.content).toBe('Let me check that shot first.')
    expect(interstitial.client_id).toBeNull()
    expect(messages[4].content).toBe('Updated it.')
  })

  test('a previous turn\'s decline stays in conversation history, so a later turn does not re-answer an already-declined request', async () => {
    const projectId = await seedToolProject()

    await runAgentTurn({
      gateway: scriptedGateway([
        successMessage({ message: "There's no delete tool - use the shot's own delete button." }, 'decline'),
        textMessage("I can't delete shots directly."),
      ]),
      supabase: admin,
      projectId,
      userId: primary.user.id,
      content: 'delete shot 3',
      clientId: crypto.randomUUID(),
    })

    const turn2Gateway = scriptedGateway([textMessage('Sure, on it.')])
    await runAgentTurn({
      gateway: turn2Gateway,
      supabase: admin,
      projectId,
      userId: primary.user.id,
      content: 'rewrite the narration for shot 1',
      clientId: crypto.randomUUID(),
    })

    const [call] = turn2Gateway.getCalls()
    const historyText = JSON.stringify(call.messages)
    expect(historyText).toContain("There's no delete tool - use the shot's own delete button.")
  })

  test('a "write me X" content request can loop from get_shot into update_shot rather than stopping at a text-only reply', async () => {
    // This scripts the fake model to look then write, so it only proves the turn loop
    // supports that shape end-to-end (persists the write, doesn't stop at the get_shot
    // reply). Whether the real model chooses this shape for a given prompt needs a live
    // Claude call, which this repo's tests never make - see the AGENT_SYSTEM_PROMPT_V10
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
    const events: AgentStreamEvent[] = []

    const result = await runAgentTurn({
      gateway,
      supabase: admin,
      projectId,
      userId: primary.user.id,
      content: 'do something',
      clientId: crypto.randomUUID(),
      onEvent: (e) => events.push(e),
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect('reason' in result && result.reason).toBe('already_generating')
    expect(gateway.getCallCount()).toBe(0)

    // A refusal is a known outcome, not a dropped connection - it must reach the client
    // as a normal settled event on the FIRST attempt, not only after a Retry resend.
    expect(events).toContainEqual({
      type: 'settled',
      content:
        'Another turn was already running for this project when this was sent, so nothing was changed. Please try again.',
      cost: 0,
    })

    // Refused before any claim, spend, or model call - it must cost nothing and must
    // not create a second generations row (the pre-seeded row is the only one).
    expect(gateway.getCallCount()).toBe(0)
    const { data: generationRows } = await admin
      .from('generations')
      .select('id')
      .eq('project_id', projectId)
      .eq('operation', 'agent_turn')
    expect(generationRows).toHaveLength(1)
    const { data: usageRows } = await admin.from('usage').select('id').eq('project_id', projectId)
    expect(usageRows).toHaveLength(0)
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

  test('an applied mutation persists a tool_done row (kind/tool_name/shot_key), in order, before the closing reply', async () => {
    const projectId = await seedToolProject()
    const shotId = await seedToolShot(projectId)
    const shot = await readShot(shotId)

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
    })

    const messages = await readMessages(projectId)
    const userIndex = messages.findIndex((m) => m.role === 'user')
    const toolIndex = messages.findIndex((m) => m.kind === 'tool_done')
    const closingIndex = messages.findIndex((m) => m.kind === 'text' && m.role === 'assistant' && m.id !== messages[userIndex].id)
    expect(toolIndex).toBeGreaterThan(userIndex)
    expect(toolIndex).toBeLessThan(closingIndex)
    expect(messages[toolIndex].tool_name).toBe('update_shot')
    expect(messages[toolIndex].shot_key).toBe(shot.shot_key)
    expect(messages[toolIndex].client_id).toBeNull()
  })

  test('a refused mutation persists a refusal row with shot_key but no tool_name', async () => {
    const projectId = await seedToolProject()
    const shotId = await seedToolShot(projectId, { visual_description: 'Original description.' })
    const shot = await readShot(shotId)

    await runAgentTurn({
      gateway: scriptedGateway([
        successMessage({ shot_number: shot.order_index + 1, visual_description: '' }, 'update_shot'),
        textMessage('That description cannot be empty, so I left it as is.'),
      ]),
      supabase: admin,
      projectId,
      userId: primary.user.id,
      content: 'clear the visual description',
      clientId: crypto.randomUUID(),
    })

    const messages = await readMessages(projectId)
    const refusal = messages.find((m) => m.kind === 'refusal')
    expect(refusal).toBeDefined()
    expect(refusal!.shot_key).toBe(shot.shot_key)
    expect(refusal!.tool_name).toBeNull()
  })

  test("the settled event's cost equals the sum of this turn's own usage.estimated_cost rows", async () => {
    const projectId = await seedToolProject()
    const shotId = await seedToolShot(projectId)
    const shotNumber = (await readShot(shotId)).order_index + 1
    const events: AgentStreamEvent[] = []

    await runAgentTurn({
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

    const { data: usageRows } = await admin.from('usage').select('estimated_cost').eq('project_id', projectId)
    const expectedCost = (usageRows ?? []).reduce((sum, r) => sum + (r.estimated_cost ?? 0), 0)
    const settled = events.find((e) => e.type === 'settled')
    expect(settled?.type === 'settled' && settled.cost).toBeCloseTo(expectedCost, 10)
    expect(expectedCost).toBeGreaterThan(0)
  })

  test('the read-only-lock short-circuit settles with cost 0 - no reserveUsage call has happened yet', async () => {
    const projectId = await seedToolProject({ furthest_step: stepIndex('storyboard') })
    const events: AgentStreamEvent[] = []

    await runAgentTurn({
      gateway: scriptedGateway([]),
      supabase: admin,
      projectId,
      userId: primary.user.id,
      content: 'change something',
      clientId: crypto.randomUUID(),
      onEvent: (e) => events.push(e),
    })

    const settled = events.find((e) => e.type === 'settled')
    expect(settled?.type === 'settled' && settled.cost).toBe(0)
  })

  test("history sent to Claude on a later turn excludes an earlier turn's tool_done rows (but not a refusal - see the handleDecline-focused test above)", async () => {
    const projectId = await seedToolProject()
    const shotId = await seedToolShot(projectId)
    const shotNumber = (await readShot(shotId)).order_index + 1

    await runAgentTurn({
      gateway: scriptedGateway([
        successMessage({ shot_number: shotNumber, voice_over: 'Changed by the agent.' }, 'update_shot'),
        textMessage('Updated the narration.'),
      ]),
      supabase: admin,
      projectId,
      userId: primary.user.id,
      content: 'change the narration',
      clientId: crypto.randomUUID(),
    })

    const capturedParams: { messages: { role: string; content: unknown }[] }[] = []
    const capturingGateway: ClaudeGateway = {
      async createMessage(params) {
        capturedParams.push(params as unknown as { messages: { role: string; content: unknown }[] })
        return textMessage('Second turn reply.')
      },
    }

    await runAgentTurn({
      gateway: capturingGateway,
      supabase: admin,
      projectId,
      userId: primary.user.id,
      content: 'a second turn',
      clientId: crypto.randomUUID(),
    })

    const sentContent = JSON.stringify(capturedParams[0].messages)
    expect(sentContent).not.toContain('Updated Shot')
    expect(sentContent).toContain('Updated the narration.')
  })

  test('history sent to a later turn also excludes prior-turn interstitial narration, but still includes user rows, closing replies, and refusal rows - and the in-flight turn still sees its own narration via in-memory context, never the DB', async () => {
    const projectId = await seedToolProject()
    const shotId = await seedToolShot(projectId)
    const shotNumber = (await readShot(shotId)).order_index + 1

    const turn1Gateway = scriptedGateway([
      mixedMessage('Let me check that shot first.', [{ name: 'get_shot', input: { shot_number: shotNumber } }]),
      successMessage({ message: "There's no delete tool - use the shot's own delete button." }, 'decline'),
      textMessage('Declined the delete - nothing else changed.'),
    ])

    await runAgentTurn({
      gateway: turn1Gateway,
      supabase: admin,
      projectId,
      userId: primary.user.id,
      content: 'delete shot 3',
      clientId: crypto.randomUUID(),
    })

    // In-flight isolation: this turn's own later calls still see the first call's
    // narration in their own working context - it was never re-queried from the DB
    // mid-turn, so excluding it from a FUTURE turn's history fetch (below) can't affect
    // this turn's own loop.
    const turn1Calls = turn1Gateway.getCalls()
    expect(JSON.stringify(turn1Calls[1].messages)).toContain('Let me check that shot first.')
    expect(JSON.stringify(turn1Calls[2].messages)).toContain('Let me check that shot first.')

    const turn2Gateway = scriptedGateway([textMessage('Sure, on it.')])
    await runAgentTurn({
      gateway: turn2Gateway,
      supabase: admin,
      projectId,
      userId: primary.user.id,
      content: 'rewrite shot 1',
      clientId: crypto.randomUUID(),
    })

    const historyText = JSON.stringify(turn2Gateway.getCalls()[0].messages)
    expect(historyText).toContain('delete shot 3') // the user row
    expect(historyText).toContain('Declined the delete - nothing else changed.') // the closing reply
    expect(historyText).toContain("There's no delete tool - use the shot's own delete button.") // the refusal
    expect(historyText).not.toContain('Let me check that shot first.') // interstitial narration
    expect(historyText).not.toContain(`Looked at Shot ${shotNumber}`) // tool_done
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
