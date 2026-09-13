import { test, expect } from '@playwright/test'
import sharp from 'sharp'
import { admin } from './supabase-test-session'
import { primary, secondary } from './fixed-users'
import { uploadReferenceImageForUser, removeReferenceImageForUser } from '../src/lib/elements/reference'

async function seedProject(overrides: Record<string, unknown> = {}) {
  const { data, error } = await admin
    .from('projects')
    .insert({
      user_id: primary.user.id,
      title: 'Elements reference test',
      source_text: 'A short film for elements-reference tests.',
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
    .insert({ project_id: projectId, name: `Element ${crypto.randomUUID()}`, type: 'character', ...overrides })
    .select('id')
    .single()
  expect(error).toBeNull()
  return data!.id as string
}

async function pngBuffer(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 200, g: 50, b: 50 } } })
    .png()
    .toBuffer()
}

async function jpegWithExifBuffer(): Promise<Buffer> {
  return sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 10, g: 100, b: 200 } } })
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toBuffer()
}

async function elementPath(elementId: string): Promise<string | null> {
  const { data } = await admin.from('elements').select('reference_image_path').eq('id', elementId).single()
  return data!.reference_image_path
}

async function listObjectsUnder(userId: string, projectId: string, elementId: string) {
  const { data, error } = await admin.storage.from('artifacts').list(`${userId}/${projectId}/elements/${elementId}`)
  expect(error).toBeNull()
  return data ?? []
}

test.describe('reference image upload', () => {
  test('uploads a valid PNG, downscaling to 1024 on the long edge and re-encoding to webp', async () => {
    const projectId = await seedProject()
    const elementId = await seedElement(projectId)
    const input = await pngBuffer(2000, 1000)

    const result = await uploadReferenceImageForUser(admin, projectId, elementId, primary.user.id, input)

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(await elementPath(elementId)).toBe(result.path)

    const { data: stored } = await admin.storage.from('artifacts').download(result.path)
    const storedBuffer = Buffer.from(await stored!.arrayBuffer())
    const meta = await sharp(storedBuffer).metadata()
    expect(meta.format).toBe('webp')
    expect(meta.width).toBe(1024)
    expect(meta.height).toBe(512)
  })

  test('accepts a real JPEG - content is the only input, there is no filename/mime parameter to spoof', async () => {
    const projectId = await seedProject()
    const elementId = await seedElement(projectId)
    const input = await sharp({ create: { width: 400, height: 400, channels: 3, background: { r: 0, g: 0, b: 0 } } })
      .jpeg()
      .toBuffer()

    const result = await uploadReferenceImageForUser(admin, projectId, elementId, primary.user.id, input)

    expect(result.success).toBe(true)
  })

  test('does not upscale an image smaller than 1024px', async () => {
    const projectId = await seedProject()
    const elementId = await seedElement(projectId)
    const input = await pngBuffer(300, 200)

    const result = await uploadReferenceImageForUser(admin, projectId, elementId, primary.user.id, input)

    expect(result.success).toBe(true)
    if (!result.success) return
    const { data: stored } = await admin.storage.from('artifacts').download(result.path)
    const meta = await sharp(Buffer.from(await stored!.arrayBuffer())).metadata()
    expect(meta.width).toBe(300)
    expect(meta.height).toBe(200)
  })

  test('strips EXIF metadata from the stored object', async () => {
    const projectId = await seedProject()
    const elementId = await seedElement(projectId)
    const input = await jpegWithExifBuffer()
    // Sanity check on the fixture itself: it actually carries EXIF before upload.
    expect((await sharp(input).metadata()).exif).toBeTruthy()

    const result = await uploadReferenceImageForUser(admin, projectId, elementId, primary.user.id, input)

    expect(result.success).toBe(true)
    if (!result.success) return
    const { data: stored } = await admin.storage.from('artifacts').download(result.path)
    const meta = await sharp(Buffer.from(await stored!.arrayBuffer())).metadata()
    expect(meta.exif).toBeUndefined()
  })

  test('rejects an SVG outright', async () => {
    const projectId = await seedProject()
    const elementId = await seedElement(projectId)
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')

    const result = await uploadReferenceImageForUser(admin, projectId, elementId, primary.user.id, svg)

    expect(result.success).toBe(false)
    expect(await elementPath(elementId)).toBeNull()
  })

  test('rejects a corrupt or unrecognized file', async () => {
    const projectId = await seedProject()
    const elementId = await seedElement(projectId)
    const garbage = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07])

    const result = await uploadReferenceImageForUser(admin, projectId, elementId, primary.user.id, garbage)

    expect(result.success).toBe(false)
  })

  test('rejects a buffer over the 8 MB cap', async () => {
    const projectId = await seedProject()
    const elementId = await seedElement(projectId)
    const oversized = Buffer.alloc(8 * 1024 * 1024 + 1)

    const result = await uploadReferenceImageForUser(admin, projectId, elementId, primary.user.id, oversized)

    expect(result.success).toBe(false)
  })

  test('replacing an existing reference leaves exactly one object in storage for that element', async () => {
    const projectId = await seedProject()
    const elementId = await seedElement(projectId)

    const first = await uploadReferenceImageForUser(admin, projectId, elementId, primary.user.id, await pngBuffer(500, 500))
    expect(first.success).toBe(true)
    if (!first.success) return

    const second = await uploadReferenceImageForUser(admin, projectId, elementId, primary.user.id, await pngBuffer(600, 600))
    expect(second.success).toBe(true)
    if (!second.success) return

    expect(second.path).not.toBe(first.path)
    expect(await elementPath(elementId)).toBe(second.path)

    const objects = await listObjectsUnder(primary.user.id, projectId, elementId)
    expect(objects.length).toBe(1)
  })

  test('a user cannot upload a reference to another user\'s element', async () => {
    const projectId = await seedProject()
    const elementId = await seedElement(projectId)

    const result = await uploadReferenceImageForUser(admin, projectId, elementId, secondary.user.id, await pngBuffer(400, 400))

    expect(result.success).toBe(false)
    expect(await elementPath(elementId)).toBeNull()
  })

  test('rejects an element/project id mismatch as not found', async () => {
    const projectId = await seedProject()
    const otherProjectId = await seedProject()
    const elementId = await seedElement(projectId)

    const result = await uploadReferenceImageForUser(admin, otherProjectId, elementId, primary.user.id, await pngBuffer(400, 400))

    expect(result.success).toBe(false)
  })
})

test.describe('reference image removal', () => {
  test('clears the path, deletes the object, and leaves the element otherwise intact', async () => {
    const projectId = await seedProject()
    const elementId = await seedElement(projectId, { name: 'Keeps Existing' })
    const uploaded = await uploadReferenceImageForUser(admin, projectId, elementId, primary.user.id, await pngBuffer(400, 400))
    expect(uploaded.success).toBe(true)

    const result = await removeReferenceImageForUser(admin, projectId, elementId, primary.user.id)

    expect(result.success).toBe(true)
    expect(await elementPath(elementId)).toBeNull()
    const objects = await listObjectsUnder(primary.user.id, projectId, elementId)
    expect(objects.length).toBe(0)

    const { data: element, error } = await admin.from('elements').select('name').eq('id', elementId).single()
    expect(error).toBeNull()
    expect(element!.name).toBe('Keeps Existing')
  })

  test('removing when there is no reference is a no-op success', async () => {
    const projectId = await seedProject()
    const elementId = await seedElement(projectId)

    const result = await removeReferenceImageForUser(admin, projectId, elementId, primary.user.id)

    expect(result.success).toBe(true)
  })

  test('a user cannot remove another user\'s reference', async () => {
    const projectId = await seedProject()
    const elementId = await seedElement(projectId)
    const uploaded = await uploadReferenceImageForUser(admin, projectId, elementId, primary.user.id, await pngBuffer(400, 400))
    expect(uploaded.success).toBe(true)
    if (!uploaded.success) return

    const result = await removeReferenceImageForUser(admin, projectId, elementId, secondary.user.id)

    expect(result.success).toBe(false)
    expect(await elementPath(elementId)).toBe(uploaded.path)
  })
})
