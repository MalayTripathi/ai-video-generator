import { test, expect } from '@playwright/test'
import { admin } from './supabase-test-session'
import { primary, secondary } from './fixed-users'
import { getProjectElementsForUser, resignElementReferenceImageForUser } from '../src/lib/elements/read'
import { ELEMENT_TYPES } from '../src/lib/config/enums'

async function seedProject(overrides: Record<string, unknown> = {}) {
  const { data, error } = await admin
    .from('projects')
    .insert({
      user_id: primary.user.id,
      title: 'Elements read test',
      source_text: 'A short film for elements-read tests.',
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

test.describe('elements read path', () => {
  test('a project with no elements returns empty groups, not an error', async () => {
    const projectId = await seedProject()

    const result = await getProjectElementsForUser(admin, projectId, primary.user.id)

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.groups.map((g) => g.type)).toEqual([...ELEMENT_TYPES])
    for (const group of result.groups) {
      expect(group.count).toBe(0)
      expect(group.elements).toEqual([])
    }
    expect(typeof result.expires_at).toBe('string')
  })

  test('soft-deleted elements are absent from the response', async () => {
    const projectId = await seedProject()
    await seedElement(projectId, { name: 'Live Character', type: 'character' })
    await seedElement(projectId, { name: 'Deleted Character', type: 'character', deleted_at: new Date().toISOString() })

    const result = await getProjectElementsForUser(admin, projectId, primary.user.id)

    expect(result.success).toBe(true)
    if (!result.success) return
    const characterGroup = result.groups.find((g) => g.type === 'character')!
    expect(characterGroup.count).toBe(1)
    expect(characterGroup.elements.map((el) => el.name)).toEqual(['Live Character'])
  })

  test('an element with no reference image returns cleanly with a null path and no URL', async () => {
    const projectId = await seedProject()
    await seedElement(projectId, { name: 'Prop', type: 'prop', description: 'A prop.' })

    const result = await getProjectElementsForUser(admin, projectId, primary.user.id)

    expect(result.success).toBe(true)
    if (!result.success) return
    const propGroup = result.groups.find((g) => g.type === 'prop')!
    expect(propGroup.count).toBe(1)
    expect(propGroup.elements[0].reference_image_path).toBeNull()
    expect(propGroup.elements[0].reference_image_url).toBeNull()
    expect(propGroup.elements[0].description).toBe('A prop.')
  })

  test('groups appear in the fixed order characters, locations, props, style regardless of insertion order', async () => {
    const projectId = await seedProject()
    await seedElement(projectId, { name: 'Style', type: 'style' })
    await seedElement(projectId, { name: 'Prop', type: 'prop' })
    await seedElement(projectId, { name: 'Location', type: 'location' })
    await seedElement(projectId, { name: 'Character', type: 'character' })

    const result = await getProjectElementsForUser(admin, projectId, primary.user.id)

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.groups.map((g) => g.type)).toEqual(['character', 'location', 'prop', 'style'])
  })

  test('a user cannot read another user\'s project elements', async () => {
    const projectId = await seedProject()
    await seedElement(projectId, { name: 'Owner-only Character', type: 'character' })

    const result = await getProjectElementsForUser(admin, projectId, secondary.user.id)

    expect(result.success).toBe(true)
    if (!result.success) return
    for (const group of result.groups) {
      expect(group.count).toBe(0)
    }
  })

  test('resigning a single path refuses a path from another user\'s project', async () => {
    const projectId = await seedProject()
    await seedElement(projectId, { name: 'Character', type: 'character', reference_image_path: `${primary.user.id}/elements/x.png` })

    const result = await resignElementReferenceImageForUser(
      admin,
      projectId,
      `${primary.user.id}/elements/x.png`,
      secondary.user.id
    )

    expect(result.success).toBe(false)
  })

  test('resigning a path that matches no live element is refused', async () => {
    const projectId = await seedProject()

    const result = await resignElementReferenceImageForUser(
      admin,
      projectId,
      `${primary.user.id}/elements/does-not-exist.png`,
      primary.user.id
    )

    expect(result.success).toBe(false)
  })
})
