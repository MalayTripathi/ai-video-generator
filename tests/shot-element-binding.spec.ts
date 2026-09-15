import { test, expect } from '@playwright/test'
import { admin } from './supabase-test-session'
import { primary, secondary } from './fixed-users'
import { stepIndex } from '../src/lib/config/pipeline'
import { deleteElementForUser } from '../src/lib/elements/write'
import {
  bindElementToShotForUser,
  unbindElementFromShotForUser,
} from '../src/app/(app)/projects/[id]/workbench/actions'

async function seedProject(overrides: Record<string, unknown> = {}) {
  const { data, error } = await admin
    .from('projects')
    .insert({
      user_id: primary.user.id,
      title: 'Shot element binding test',
      source_text: 'A short film for shot-element-binding tests.',
      video_type: 'auto',
      duration_target: '30-60s',
      current_step: 'workbench',
      video_model: 'mochi-1',
      ...overrides,
    })
    .select('id')
    .single()
  expect(error).toBeNull()
  return data!.id as string
}

async function seedElement(projectId: string, overrides: Record<string, unknown> = {}) {
  const { data, error } = await admin
    .from('elements')
    .insert({ project_id: projectId, name: 'Element', type: 'character', ...overrides })
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
      shot_key: `t${Math.random().toString(36).slice(2, 6)}`,
      voice_over: 'Placeholder voice-over.',
      ...overrides,
    })
    .select('id')
    .single()
  expect(error).toBeNull()
  return data!.id as string
}

test.describe('bind an element to a shot', () => {
  test('binds and sets image_prompt_stale only - never video_prompt_stale or voiceover_stale', async () => {
    const projectId = await seedProject()
    const elementId = await seedElement(projectId, { name: 'Hero' })
    const shotId = await seedShot(projectId)

    const result = await bindElementToShotForUser(admin, shotId, elementId, primary.user.id)

    expect(result.success).toBe(true)
    const { data: shotElement } = await admin
      .from('shot_elements')
      .select('shot_id, element_id')
      .eq('shot_id', shotId)
      .eq('element_id', elementId)
      .maybeSingle()
    expect(shotElement).not.toBeNull()

    const { data: shot } = await admin
      .from('shots')
      .select('image_prompt_stale, video_prompt_stale')
      .eq('id', shotId)
      .single()
    expect(shot!.image_prompt_stale).toBe(true)
    expect(shot!.video_prompt_stale).toBe(false)

    const { data: project } = await admin.from('projects').select('voiceover_stale').eq('id', projectId).single()
    expect(project!.voiceover_stale).toBe(false)
  })

  test('never changes the compiled image_prompt/video_prompt text - only the flag', async () => {
    const projectId = await seedProject()
    const elementId = await seedElement(projectId, { name: 'Hero' })
    const shotId = await seedShot(projectId, {
      image_prompt: 'A pre-existing, already-paid-for image prompt.',
      video_prompt: 'A pre-existing, already-paid-for video prompt.',
      image_prompt_stale: false,
      video_prompt_stale: false,
    })

    const result = await bindElementToShotForUser(admin, shotId, elementId, primary.user.id)

    expect(result.success).toBe(true)
    const { data: shot } = await admin
      .from('shots')
      .select('image_prompt, video_prompt, image_prompt_stale')
      .eq('id', shotId)
      .single()
    expect(shot!.image_prompt).toBe('A pre-existing, already-paid-for image prompt.')
    expect(shot!.video_prompt).toBe('A pre-existing, already-paid-for video prompt.')
    expect(shot!.image_prompt_stale).toBe(true)
  })

  test('rejects binding the style element, and no shot_elements row is created', async () => {
    const projectId = await seedProject()
    const styleId = await seedElement(projectId, { name: 'Project Style', type: 'style' })
    const shotId = await seedShot(projectId)

    const result = await bindElementToShotForUser(admin, shotId, styleId, primary.user.id)

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.reason).toBe('style')
    const { data: shotElement } = await admin
      .from('shot_elements')
      .select('shot_id')
      .eq('shot_id', shotId)
      .eq('element_id', styleId)
      .maybeSingle()
    expect(shotElement).toBeNull()
  })

  test('rejects binding an element from a different project than the shot', async () => {
    const projectA = await seedProject()
    const projectB = await seedProject()
    const shotId = await seedShot(projectA)
    const elementId = await seedElement(projectB, { name: 'Wrong Project Element' })

    const result = await bindElementToShotForUser(admin, shotId, elementId, primary.user.id)

    expect(result.success).toBe(false)
  })

  test('rejects binding a soft-deleted element', async () => {
    const projectId = await seedProject()
    const elementId = await seedElement(projectId, { name: 'Gone', deleted_at: new Date().toISOString() })
    const shotId = await seedShot(projectId)

    const result = await bindElementToShotForUser(admin, shotId, elementId, primary.user.id)

    expect(result.success).toBe(false)
  })

  test('binding the same pair twice is a benign no-op, not an error - and only one row exists', async () => {
    const projectId = await seedProject()
    const elementId = await seedElement(projectId, { name: 'Hero' })
    const shotId = await seedShot(projectId)

    const first = await bindElementToShotForUser(admin, shotId, elementId, primary.user.id)
    const second = await bindElementToShotForUser(admin, shotId, elementId, primary.user.id)

    expect(first.success).toBe(true)
    expect(second.success).toBe(true)
    if (second.success) expect(second.unchanged).toBe(true)

    const { data: rows } = await admin
      .from('shot_elements')
      .select('shot_id')
      .eq('shot_id', shotId)
      .eq('element_id', elementId)
    expect(rows?.length).toBe(1)
  })

  test('refuses to bind once the workbench is locked past storyboard, with no DB change', async () => {
    const projectId = await seedProject({ furthest_step: stepIndex('storyboard') })
    const elementId = await seedElement(projectId, { name: 'Hero' })
    const shotId = await seedShot(projectId)

    const result = await bindElementToShotForUser(admin, shotId, elementId, primary.user.id)

    expect(result.success).toBe(false)
    const { data: shotElement } = await admin
      .from('shot_elements')
      .select('shot_id')
      .eq('shot_id', shotId)
      .eq('element_id', elementId)
      .maybeSingle()
    expect(shotElement).toBeNull()
  })

  test('a user cannot bind an element in another user\'s project', async () => {
    const projectId = await seedProject()
    const elementId = await seedElement(projectId, { name: 'Hero' })
    const shotId = await seedShot(projectId)

    const result = await bindElementToShotForUser(admin, shotId, elementId, secondary.user.id)

    expect(result.success).toBe(false)
    const { data: shotElement } = await admin
      .from('shot_elements')
      .select('shot_id')
      .eq('shot_id', shotId)
      .eq('element_id', elementId)
      .maybeSingle()
    expect(shotElement).toBeNull()
  })
})

test.describe('unbind an element from a shot', () => {
  test('removes the binding, sets image_prompt_stale, and leaves the element untouched', async () => {
    const projectId = await seedProject()
    const elementId = await seedElement(projectId, { name: 'Hero', reference_image_path: 'projects/x/elements/hero.png' })
    const shotId = await seedShot(projectId)
    await admin.from('shot_elements').insert({ shot_id: shotId, element_id: elementId })

    const before = await admin.from('elements').select('name, reference_image_path, status').eq('id', elementId).single()

    const result = await unbindElementFromShotForUser(admin, shotId, elementId, primary.user.id)

    expect(result.success).toBe(true)
    const { data: shotElement } = await admin
      .from('shot_elements')
      .select('shot_id')
      .eq('shot_id', shotId)
      .eq('element_id', elementId)
      .maybeSingle()
    expect(shotElement).toBeNull()

    const { data: shot } = await admin.from('shots').select('image_prompt_stale').eq('id', shotId).single()
    expect(shot!.image_prompt_stale).toBe(true)

    const after = await admin.from('elements').select('name, reference_image_path, status').eq('id', elementId).single()
    expect(after.data).toEqual(before.data)
  })

  test('never changes the compiled image_prompt/video_prompt text - only the flag', async () => {
    const projectId = await seedProject()
    const elementId = await seedElement(projectId, { name: 'Hero' })
    const shotId = await seedShot(projectId, {
      image_prompt: 'A pre-existing, already-paid-for image prompt.',
      video_prompt: 'A pre-existing, already-paid-for video prompt.',
      image_prompt_stale: false,
      video_prompt_stale: false,
    })
    await admin.from('shot_elements').insert({ shot_id: shotId, element_id: elementId })

    const result = await unbindElementFromShotForUser(admin, shotId, elementId, primary.user.id)

    expect(result.success).toBe(true)
    const { data: shot } = await admin
      .from('shots')
      .select('image_prompt, video_prompt, image_prompt_stale')
      .eq('id', shotId)
      .single()
    expect(shot!.image_prompt).toBe('A pre-existing, already-paid-for image prompt.')
    expect(shot!.video_prompt).toBe('A pre-existing, already-paid-for video prompt.')
    expect(shot!.image_prompt_stale).toBe(true)
  })

  test('refuses to unbind once the workbench is locked past storyboard, and the row survives', async () => {
    const projectId = await seedProject()
    const elementId = await seedElement(projectId, { name: 'Hero' })
    const shotId = await seedShot(projectId)
    await admin.from('shot_elements').insert({ shot_id: shotId, element_id: elementId })
    await admin.from('projects').update({ furthest_step: stepIndex('storyboard') }).eq('id', projectId)

    const result = await unbindElementFromShotForUser(admin, shotId, elementId, primary.user.id)

    expect(result.success).toBe(false)
    const { data: shotElement } = await admin
      .from('shot_elements')
      .select('shot_id')
      .eq('shot_id', shotId)
      .eq('element_id', elementId)
      .maybeSingle()
    expect(shotElement).not.toBeNull()
  })

  test('a user cannot unbind an element in another user\'s project', async () => {
    const projectId = await seedProject()
    const elementId = await seedElement(projectId, { name: 'Hero' })
    const shotId = await seedShot(projectId)
    await admin.from('shot_elements').insert({ shot_id: shotId, element_id: elementId })

    const result = await unbindElementFromShotForUser(admin, shotId, elementId, secondary.user.id)

    expect(result.success).toBe(false)
    const { data: shotElement } = await admin
      .from('shot_elements')
      .select('shot_id')
      .eq('shot_id', shotId)
      .eq('element_id', elementId)
      .maybeSingle()
    expect(shotElement).not.toBeNull()
  })

  test('unbinding an element\'s last binding makes it deletable again', async () => {
    const projectId = await seedProject()
    const elementId = await seedElement(projectId, { name: 'Hero' })
    const shotId = await seedShot(projectId)
    await admin.from('shot_elements').insert({ shot_id: shotId, element_id: elementId })

    const blockedDelete = await deleteElementForUser(admin, elementId, primary.user.id)
    expect(blockedDelete.success).toBe(false)

    const unbindResult = await unbindElementFromShotForUser(admin, shotId, elementId, primary.user.id)
    expect(unbindResult.success).toBe(true)

    const allowedDelete = await deleteElementForUser(admin, elementId, primary.user.id)
    expect(allowedDelete.success).toBe(true)
  })
})
