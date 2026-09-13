import { test, expect } from '@playwright/test'
import { admin } from './supabase-test-session'
import { primary, secondary } from './fixed-users'
import { getProjectElementsForUser } from '../src/lib/elements/read'
import {
  createElementForUser,
  updateElementNameForUser,
  updateElementDescriptionForUser,
  deleteElementForUser,
} from '../src/lib/elements/write'

async function seedProject(overrides: Record<string, unknown> = {}) {
  const { data, error } = await admin
    .from('projects')
    .insert({
      user_id: primary.user.id,
      title: 'Elements write test',
      source_text: 'A short film for elements-write tests.',
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

test.describe('elements write path', () => {
  test.describe('create', () => {
    test('creates an element with no reference image', async () => {
      const projectId = await seedProject()

      const result = await createElementForUser(admin, projectId, 'A New Character', 'A description.', 'character', primary.user.id)

      expect(result.success).toBe(true)
      if (!result.success) return
      expect(result.element.name).toBe('A New Character')
      expect(result.element.description).toBe('A description.')
      expect(result.element.type).toBe('character')
      expect(result.element.reference_image_path).toBeNull()
      expect(result.element.reference_image_url).toBeNull()
    })

    test('rejects creating a style element', async () => {
      const projectId = await seedProject()

      const result = await createElementForUser(admin, projectId, 'A Style', null, 'style', primary.user.id)

      expect(result.success).toBe(false)
    })

    test('rejects a name colliding with a live element of a different type, naming that type', async () => {
      const projectId = await seedProject()
      await seedElement(projectId, { name: 'Taj Mahal', type: 'location' })

      const result = await createElementForUser(admin, projectId, 'Taj Mahal', null, 'character', primary.user.id)

      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.reason).toBe('collision')
      expect(result.conflictingType).toBe('location')
      expect(result.error).toContain('location')
    })

    test('succeeds against a name matching only a soft-deleted element', async () => {
      const projectId = await seedProject()
      await seedElement(projectId, { name: 'Reusable Name', type: 'prop', deleted_at: new Date().toISOString() })

      const result = await createElementForUser(admin, projectId, 'Reusable Name', null, 'prop', primary.user.id)

      expect(result.success).toBe(true)
    })

    test('a user cannot create an element in another user\'s project', async () => {
      const projectId = await seedProject()

      const result = await createElementForUser(admin, projectId, 'Intruder', null, 'character', secondary.user.id)

      expect(result.success).toBe(false)
    })
  })

  test.describe('rename', () => {
    test('renames an element', async () => {
      const projectId = await seedProject()
      const elementId = await seedElement(projectId, { name: 'Old Name' })

      const result = await updateElementNameForUser(admin, elementId, 'New Name', primary.user.id)

      expect(result.success).toBe(true)
      const { data } = await admin.from('elements').select('name').eq('id', elementId).single()
      expect(data!.name).toBe('New Name')
    })

    test('renaming to the same value is a no-op', async () => {
      const projectId = await seedProject()
      const elementId = await seedElement(projectId, { name: 'Same Name' })

      const result = await updateElementNameForUser(admin, elementId, 'Same Name', primary.user.id)

      expect(result.success).toBe(true)
      if (!result.success) return
      expect(result.unchanged).toBe(true)
    })

    test('rejects renaming to an existing live name, with the same collision shape as create', async () => {
      const projectId = await seedProject()
      await seedElement(projectId, { name: 'Taken Name', type: 'prop' })
      const elementId = await seedElement(projectId, { name: 'Other Name', type: 'character' })

      const result = await updateElementNameForUser(admin, elementId, 'Taken Name', primary.user.id)

      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.reason).toBe('collision')
      expect(result.conflictingType).toBe('prop')
    })

    test('renaming a style element succeeds', async () => {
      const projectId = await seedProject()
      const elementId = await seedElement(projectId, { name: 'Old Style', type: 'style' })

      const result = await updateElementNameForUser(admin, elementId, 'New Style', primary.user.id)

      expect(result.success).toBe(true)
    })

    test('a user cannot rename an element in another user\'s project', async () => {
      const projectId = await seedProject()
      const elementId = await seedElement(projectId, { name: 'Untouched' })

      const result = await updateElementNameForUser(admin, elementId, 'Hijacked', secondary.user.id)

      expect(result.success).toBe(false)
      const { data } = await admin.from('elements').select('name').eq('id', elementId).single()
      expect(data!.name).toBe('Untouched')
    })
  })

  test.describe('description', () => {
    test('edits the description independently of the name', async () => {
      const projectId = await seedProject()
      const elementId = await seedElement(projectId, { name: 'Keeps Name', description: 'Old description.' })

      const result = await updateElementDescriptionForUser(admin, elementId, 'New description.', primary.user.id)

      expect(result.success).toBe(true)
      const { data } = await admin.from('elements').select('name, description').eq('id', elementId).single()
      expect(data!.name).toBe('Keeps Name')
      expect(data!.description).toBe('New description.')
    })

    test('setting the same description twice is a no-op the second time', async () => {
      const projectId = await seedProject()
      const elementId = await seedElement(projectId, { name: 'Elem', description: 'Same.' })

      const result = await updateElementDescriptionForUser(admin, elementId, 'Same.', primary.user.id)

      expect(result.success).toBe(true)
      if (!result.success) return
      expect(result.unchanged).toBe(true)
    })
  })

  test.describe('delete', () => {
    test('deletes an unbound element, and it disappears from the read path', async () => {
      const projectId = await seedProject()
      const elementId = await seedElement(projectId, { name: 'Unbound' })

      const result = await deleteElementForUser(admin, elementId, primary.user.id)

      expect(result.success).toBe(true)
      const read = await getProjectElementsForUser(admin, projectId, primary.user.id)
      expect(read.success).toBe(true)
      if (!read.success) return
      const characterGroup = read.groups.find((g) => g.type === 'character')!
      expect(characterGroup.elements.map((e) => e.id)).not.toContain(elementId)
    })

    test('refuses to delete an element bound to shots via shot_elements, naming both shots', async () => {
      const projectId = await seedProject()
      const elementId = await seedElement(projectId, { name: 'Bound Character' })
      const shot1 = await seedShot(projectId, { order_index: 0, visual_description: 'Wide shot of the hero.' })
      const shot2 = await seedShot(projectId, { order_index: 1, visual_description: 'Close up of the hero.' })
      await admin.from('shot_elements').insert([
        { shot_id: shot1, element_id: elementId },
        { shot_id: shot2, element_id: elementId },
      ])

      const result = await deleteElementForUser(admin, elementId, primary.user.id)

      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.reason).toBe('bound')
      expect(result.boundShots?.map((s) => s.shot_id).sort()).toEqual([shot1, shot2].sort())
      expect(result.boundShots?.find((s) => s.shot_id === shot1)?.shot_number).toBe(1)
      expect(result.boundShots?.find((s) => s.shot_id === shot2)?.shot_number).toBe(2)
    })

    test('refuses to delete an element bound only via shot_dialogue', async () => {
      const projectId = await seedProject()
      const elementId = await seedElement(projectId, { name: 'Speaker' })
      const shot1 = await seedShot(projectId, { order_index: 0 })
      await admin.from('shot_dialogue').insert({
        project_id: projectId,
        shot_id: shot1,
        element_id: elementId,
        line: 'Hello there.',
        order_index: 0,
      })

      const result = await deleteElementForUser(admin, elementId, primary.user.id)

      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.reason).toBe('bound')
      expect(result.boundShots?.map((s) => s.shot_id)).toEqual([shot1])
    })

    test('refuses to delete a style element', async () => {
      const projectId = await seedProject()
      const elementId = await seedElement(projectId, { name: 'Style', type: 'style' })

      const result = await deleteElementForUser(admin, elementId, primary.user.id)

      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.reason).toBe('style')
    })

    test('a user cannot delete an element in another user\'s project', async () => {
      const projectId = await seedProject()
      const elementId = await seedElement(projectId, { name: 'Untouched' })

      const result = await deleteElementForUser(admin, elementId, secondary.user.id)

      expect(result.success).toBe(false)
      const { data } = await admin.from('elements').select('deleted_at').eq('id', elementId).single()
      expect(data!.deleted_at).toBeNull()
    })
  })
})
